const express = require("express"),
  app = express(),
  server = require("http").Server(app),
  io = require("socket.io")(server),
  port = 3000,
  path = require("path"),
  bodyParser = require("body-parser"),
  fs = require("fs");

// --- Optional native/hardware modules. The web UI still runs if the MindWave
// --- headset, serial device, or compiled addons (sqlite3/serialport/thinkgear)
// --- are missing; each falls back to a harmless stub.
let thinkgear, SerialPort, ReadlineParser, sqlite3;

try {
  thinkgear = require("node-thinkgear-sockets");
} catch (e) {
  console.warn("node-thinkgear-sockets unavailable - using stub (no headset).");
  thinkgear = {
    createClient: () => ({
      on: () => {},
      connect: () => console.warn("ThinkGear stub: no headset connected."),
    }),
  };
}

// serialport v12: named exports, and the readline parser is a separate package.
try {
  ({ SerialPort } = require("serialport"));
  ({ ReadlineParser } = require("@serialport/parser-readline"));
} catch (e) {
  console.warn("serialport unavailable - using stub (no COM device).");
  SerialPort = class {
    constructor() {
      this.isOpen = false;
      this.write = (d, cb) => cb && cb();
      this.pipe = () => ({ on: () => {} });
      this.on = () => {};
    }
    static list() {
      return Promise.resolve([]);
    }
  };
  ReadlineParser = class {};
}

try {
  sqlite3 = require("sqlite3");
} catch (e) {
  console.warn("sqlite3 unavailable - using in-memory stub.");
  sqlite3 = {
    Database: class {
      constructor(file, cb) {
        cb && cb(null);
      }
      run(sql, ...args) {
        const cb = args[args.length - 1];
        if (typeof cb === "function") cb.call({ lastID: 0 }, null);
      }
    },
  };
}

const client = thinkgear.createClient({ enableRawOutput: false });

// The MindWave headset talks to a local ThinkGear Connector (TCP :13854). When
// it isn't running (no hardware), net.connect emits an unhandled 'error' and
// crashes the process. Guard that so the web UI keeps running without a headset.
if (client && client.connect) {
  const originalConnect = client.connect.bind(client);
  client.connect = function () {
    originalConnect();
    if (client.client) {
      client.client.on("error", (err) => {
        console.warn(
          "ThinkGear connector not reachable - continuing without headset:",
          err.code || err.message
        );
      });
    }
  };
}

let usbport = null;

// --- Master -> client laptop relay -------------------------------------------
// The master laptop's server forwards "start"/"stop" to the client laptop's
// server so the client's ESP32 also gets 's'/'f'. Override with PEER_URL env.
// If PEER_URL points at this machine itself (i.e. we ARE the client laptop),
// the relay is disabled automatically.
const PEER_URL = process.env.PEER_URL || "http://192.168.0.233:3000";
let peer = null;

function isOwnAddress(url) {
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1") return true;
    const ifaces = require("os").networkInterfaces();
    return Object.values(ifaces)
      .flat()
      .some((i) => i && i.address === host);
  } catch (e) {
    return false;
  }
}

if (isOwnAddress(PEER_URL)) {
  console.log(`Peer relay disabled (${PEER_URL} is this machine - client mode).`);
} else {
  try {
    peer = require("socket.io-client")(PEER_URL, { reconnection: true });
    peer.on("connect", () => console.log(`Connected to client laptop at ${PEER_URL}`));
    peer.on("disconnect", () => console.warn(`Disconnected from client laptop ${PEER_URL}`));
    peer.on("connect_error", (err) =>
      console.warn(`Cannot reach client laptop ${PEER_URL}:`, err.message || err)
    );
  } catch (e) {
    console.warn("socket.io-client unavailable - peer relay disabled.");
  }
}

// Forward an event to the client laptop. Marked fromPeer so it is never
// relayed back (prevents loops if both laptops run this code).
function relayToPeer(event, payload) {
  if (!peer) return;
  if (!peer.connected) {
    console.error(`Client laptop NOT connected - "${event}" was not sent to ${PEER_URL}`);
    return;
  }
  peer.emit(event, Object.assign({}, payload, { fromPeer: true }));
  console.log(`Relayed "${event}" to client laptop ${PEER_URL}`);
}
let parser = null;

// True only while a round is actually running. Used so that MindWave attention
// values are not written to the ESP32 after the game has finished (otherwise the
// speed chars 'a'-'e' keep streaming and override the 'f' stop command).
let gameRunning = false;

// Writes a single command character to this laptop's ESP32 over serial.
function writeToEsp(cmd, label) {
  if (!usbport || !usbport.isOpen) {
    console.error(`Serial port not ready - cannot send "${cmd}"`);
    return;
  }
  usbport.write(cmd, function (err) {
    if (err) {
      return console.log("Error on write: ", err.message);
    }
    console.log(`message written as ${cmd}${label ? " (" + label + ")" : ""}`);
  });
}

const db = new sqlite3.Database("winnerList.db", (err) => {
  if (err) {
    console.error("Error opening database:", err.message);
  } else {
    console.log("Connected to the sqlite3 database");
  }
});

db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use("/asset", express.static(path.join(__dirname, "asset")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.get("/", function (req, res) {
  res.render("newGuage.ejs");
});

app.get("/form", function (req, res) {
  res.render("form.ejs");
});

app.get("/admin", function (req, res) {
  res.render("admin.ejs");
});

server.listen(port, () => console.log("Server listening on " + port));

io.on("connection", function (socket) {
  console.log("conncted");

  //Writing 's' to serial port to start and send name to main screen.
  //On the master this is also forwarded to the client laptop.
  socket.on("start", (e) => {
    gameRunning = true;
    writeToEsp("s", e && e.fromPeer ? "start - from master" : "start");
    io.emit("getUser", e);
    if (!(e && e.fromPeer)) relayToPeer("start", e);
  });

  //Writing 'f' to serial port to stop this laptop's ESP32 (and the client's).
  socket.on("stop", (e) => {
    gameRunning = false;
    writeToEsp("f", e && e.fromPeer ? "stop - from master" : "stop");
    if (!(e && e.fromPeer)) relayToPeer("stop", e);
  });

  // Winner name wil be saved DB.
  socket.on("winnerName", (e) => {
    db.run("INSERT INTO users (name) VALUES (?)", e, function (err) {
      if (err) {
        console.error("Error inserting data:", err.message);
      } else {
        console.log(`Row inserted with ID: ${this.lastID}`);
      }
    });
  });

  fs.readFile("selectedPort.json", (err, data) => {
    if (err) {
      console.error("Error reading selectedPort.json:", err);
    } else {
      const selectedPort = JSON.parse(data);
      socket.emit("selectedPortData", selectedPort);
    }
  });

  //To get COM port list.
  socket.on("getComList", () => {
    SerialPort.list().then((e) => {
      io.emit("comPortList", e);
    });
  });

  //Sending selected COM to client.
  socket.on("selectedComPort", (selectedPort) => {
    fs.writeFile("selectedPort.json", JSON.stringify(selectedPort), (err) => {
      if (err) {
        console.error("Error writing selectedPort.json:", err);
      }
    });
  });
});

//For Selecting port from json file
fs.readFile("selectedPort.json", (err, data) => {
  if (err) {
    console.error("Error reading selectedPort.json:", err);
  } else {
    const selectedPort = JSON.parse(data);
    console.log(`Conneted to Com Port ${selectedPort}`);
    io.emit("selectedPortData", selectedPort);

    //Initializing Serial Port
    usbport = new SerialPort({
      path: selectedPort,
      baudRate: 115200,
    });
    usbport.on("error", (err) => {
      console.error("Serial port error:", err.message);
    });
    parser = usbport.pipe(new ReadlineParser({ delimiter: "\n" }));

    //Reading winner from serial port.
    //The ESP32 that finishes first sends "1" - that laptop's player is the winner.
    parser.on("data", function (data) {
      const msg = String(data).trim();
      if (msg === "") return;
      console.log("ESP32 ->", JSON.stringify(msg));

      if (msg === "1") {
        console.log("Winner signal (1) received from this laptop's ESP32");

        // Stop our own board immediately, without waiting for the browser
        // round-trip, and stop streaming attention values to it.
        gameRunning = false;
        writeToEsp("f", "stop - local winner");

        // Tell every connected page. "winner" is the event the game screen uses;
        // "winnerOne" is kept so an older game screen still works.
        io.emit("winner");
        io.emit("winnerOne");
      }
    });

    //Reading data from MindWave headset, calculating speed based coming data and writing speed to serial port
    client.on("data", function (data) {
      var myobj = data;
      if (!myobj.eSense || myobj.eSense.attention === undefined) return; // safety check

      var attention = myobj.eSense.attention;
      console.log("Attention:", attention);

      // Always emit so the form page keeps showing the headset as connected.
      io.emit("meditation", attention);

      // But only drive the motor while a round is running, otherwise these
      // writes would immediately undo the 'f' stop command.
      if (!gameRunning) return;

      if (attention >= 0 && attention < 5) {
        writeToEsp("e");
      } else if (attention >= 5 && attention <= 20) {
        writeToEsp("a");
      } else if (attention > 20 && attention <= 40) {
        writeToEsp("b");
      } else if (attention > 40 && attention <= 70) {
        writeToEsp("c");
      } else if (attention > 70) {
        writeToEsp("d");
      }
    });
  }
});

// The error handler is attached inside the guarded connect() wrapper above.
client.connect();
