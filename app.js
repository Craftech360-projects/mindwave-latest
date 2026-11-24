const express = require("express"),
  app = express(),
  server = require("http").Server(app),
  io = require("socket.io")(server),
  // 3000 unless told otherwise, so a second instance can run beside a live
  // one - the kiosk itself never sets this.
  port = process.env.PORT || 3000,
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
      all(sql, ...args) {
        // No database, so no history. The leaderboard renders its empty slots.
        const cb = args[args.length - 1];
        if (typeof cb === "function") cb(null, []);
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
// Unset keeps the venue default. Set to blank to disable the relay outright,
// which is what a single-laptop bench wants - "||" would have swallowed that.
const PEER_URL =
  process.env.PEER_URL === undefined
    ? "http://192.168.0.233:3000"
    : process.env.PEER_URL;
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

if (!PEER_URL) {
  console.log("Peer relay disabled (PEER_URL is blank - single-laptop mode).");
} else if (isOwnAddress(PEER_URL)) {
  console.log(`Peer relay disabled (${PEER_URL} is this machine - client mode).`);
} else {
  try {
    // websocket only: skips the slow HTTP long-polling phase socket.io v2
    // otherwise starts with, so each emit goes out immediately on an open TCP
    // connection.
    peer = require("socket.io-client")(PEER_URL, {
      reconnection: true,
      reconnectionDelay: 500,
      transports: ["websocket"],
    });
    peer.on("connect", () => {
      console.log(`Connected to client laptop at ${PEER_URL}`);
      measurePeerLatency();
    });
    peer.on("disconnect", () => console.warn(`Disconnected from client laptop ${PEER_URL}`));
    peer.on("connect_error", (err) =>
      console.warn(`Cannot reach client laptop ${PEER_URL}:`, err.message || err)
    );
  } catch (e) {
    console.warn("socket.io-client unavailable - peer relay disabled.");
  }
}

// Round-trip time to the client laptop, smoothed. Used to delay this laptop's
// own 's' by half the trip so both ESP32s get it at about the same moment.
// Needs the client to run this code too (it answers "peerPing"); if it runs
// older code there is no answer and no compensation is applied.
let peerRtt = 0;
const MAX_COMPENSATION_MS = 300;

function measurePeerLatency() {
  if (!peer || !peer.connected) return;
  const t0 = Date.now();
  peer.emit("peerPing", t0, () => {
    const rtt = Date.now() - t0;
    peerRtt = peerRtt ? Math.round(peerRtt * 0.7 + rtt * 0.3) : rtt;
  });
}
setInterval(measurePeerLatency, 2000);

function localDelayMs() {
  if (!peer || !peer.connected) return 0;
  return Math.min(Math.round(peerRtt / 2), MAX_COMPENSATION_MS);
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
  console.log(`Relayed "${event}" to client laptop (rtt ~${peerRtt} ms)`);
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

// Databases written before the leaderboard screen have no finish time. ALTER
// is the only way to add it in place, and SQLite reports "already exists" as an
// error rather than a no-op, so the error is swallowed deliberately.
db.run("ALTER TABLE users ADD COLUMN seconds INTEGER", () => {});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use("/asset", express.static(path.join(__dirname, "asset")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// mm:ss is what the leaderboard shows. A race is 45 seconds, so two fields
// are enough; anything longer is clamped by the round itself.
function mmss(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// The seven names the Figma frame was drawn with. Only reachable through
// ?demo=1, and only so the screen can be checked without a day of races in
// the database.
const DEMO_BOARD = [
  { name: "Abilash", time: "00:32" }, { name: "Akshay", time: "00:42" },
  { name: "Ajay", time: "00:43" },    { name: "Rahul", time: "00:48" },
  { name: "Tinku", time: "00:49" },   { name: "Ramu", time: "00:50" },
  { name: "Soham", time: "00:52" },
];

app.get("/", function (req, res) {
  // The screen reads player 02 straight from the peer laptop, so it needs the
  // same address the relay uses. Hardcoding it in the view meant a bench with
  // no second laptop retried a dead socket forever.
  res.render("play.ejs", { demo: req.query.demo || "", peerUrl: PEER_URL });
});

app.get("/form", function (req, res) {
  // Player 02's headset reports to the peer laptop, so the registration screen
  // needs the same address the gameplay screen does to light its lamp.
  res.render("player-info.ejs", { peerUrl: PEER_URL });
});

app.get("/control", function (req, res) {
  res.render("control.ejs", { state: req.query.state || "start" });
});

app.get("/leaderboard", function (req, res) {
  if (req.query.demo) return res.render("leaderboard.ejs", { rows: DEMO_BOARD });

  // Fastest first. Rows written before the finish-time column exists sort last
  // rather than disappearing - a winner with no time is still a winner.
  db.all(
    "SELECT name, seconds FROM users ORDER BY (seconds IS NULL), seconds ASC, id ASC LIMIT 7",
    (err, found) => {
      if (err) {
        console.error("Leaderboard query failed:", err.message);
        found = [];
      }
      res.render("leaderboard.ejs", {
        rows: (found || []).map((r) => ({ name: r.name, time: mmss(r.seconds) })),
      });
    }
  );
});

app.get("/admin", function (req, res) {
  res.render("admin.ejs");
});

server.listen(port, () => console.log("Server listening on " + port));

io.on("connection", function (socket) {
  console.log("conncted");

  //Writing 's' to serial port to start and send name to main screen.
  //On the master this is also forwarded to the client laptop.
  //The client laptop is sent "start" FIRST, then this laptop's own 's' is
  //written after half the measured round-trip so both boards start together.
  socket.on("start", (e) => {
    const fromPeer = !!(e && e.fromPeer);
    if (fromPeer) {
      gameRunning = true;
      writeToEsp("s", "start - from master");
    } else {
      relayToPeer("start", e);
      const delay = localDelayMs();
      setTimeout(() => {
        gameRunning = true;
        writeToEsp("s", delay ? `start, synced +${delay} ms` : "start");
      }, delay);
    }
    io.emit("getUser", e);
  });

  //Writing 'f' to serial port to stop this laptop's ESP32 (and the client's).
  socket.on("stop", (e) => {
    gameRunning = false;
    const fromPeer = !!(e && e.fromPeer);
    if (!fromPeer) relayToPeer("stop", e);
    writeToEsp("f", fromPeer ? "stop - from master" : "stop");
  });

  //Latency probe from the master laptop - just echo back immediately.
  socket.on("peerPing", (t, ack) => {
    if (typeof ack === "function") ack(t);
  });

  // Winner name wil be saved DB.
  socket.on("winnerName", (e) => {
    // Older game screens send a bare name; the current one sends
    // { name, seconds } so the leaderboard has something to sort on.
    const name = typeof e === "string" ? e : (e && e.name) || "";
    const seconds =
      e && typeof e === "object" && typeof e.seconds === "number" ? e.seconds : null;
    if (!name) return;

    db.run("INSERT INTO users (name, seconds) VALUES (?, ?)", name, seconds, function (err) {
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
