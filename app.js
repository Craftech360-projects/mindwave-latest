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
let thinkgear, SerialPort, sqlite3;

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

try {
  SerialPort = require("serialport");
} catch (e) {
  console.warn("serialport unavailable - using stub (no COM device).");
  SerialPort = class {
    constructor() {
      this.write = (d, cb) => cb && cb();
      this.pipe = () => ({ on: () => {} });
    }
    static list() {
      return Promise.resolve([]);
    }
    static get parsers() {
      return { Readline: class {} };
    }
  };
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

  //Writing 'S' to serial port to start and send name to main screen.
  socket.on("start", (e) => {
    usbport.write("s", function (err) {
      if (err) {
        return console.log("Error on write: ", err.message);
      }
      console.log("message written as " + "s");
      io.emit("getUser", e);
    });
  });

  //Writing 'F' to serial port to stop.
  socket.on("stop", (e) => {
    usbport.write("f", function (err) {
      if (err) {
        return console.log("Error on write: ", err.message);
      }
      console.log("message written as " + "f");
    });
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
    Readline = SerialPort.parsers.Readline;
    usbport = new SerialPort(selectedPort, {
      baudRate: 115200,
    });
    parser = usbport.pipe(new Readline());

    //Reading winner from serial port
    parser.on("data", function (data) {
      if (data == 1) {
        io.emit("winnerOne");
      }
    });

    //Reading data from MindWave headset, calculating speed based coming data and writing speed to serial port
    client.on("data", function (data) {
      var myobj = data;
      if (!myobj.eSense || myobj.eSense.attention === undefined) return; // safety check

      var attention = myobj.eSense.attention;
      console.log("Attention:", attention);
      io.emit("meditation", attention);

      if (attention >= 0 && attention < 5) {
        usbport.write("e", function (err) {
          if (err) {
            return console.log("Error on write: ", err.message);
          }
          console.log("message written as e");
        });
      } else if (attention > 5 && attention <= 20) {
        usbport.write("a", function (err) {
          if (err) return console.log("Error on write: ", err.message);
          console.log("message written as a");
        });
      } else if (attention > 20 && attention <= 40) {
        usbport.write("b", function (err) {
          if (err) return console.log("Error on write: ", err.message);
          console.log("message written as b");
        });
      } else if (attention > 40 && attention <= 70) {
        usbport.write("c", function (err) {
          if (err) return console.log("Error on write: ", err.message);
          console.log("message written as c");
        });
      } else if (attention > 70) {
        usbport.write("d", function (err) {
          if (err) return console.log("Error on write: ", err.message);
          console.log("message written as d");
        });
      }
    });
  }
});

client.connect();
