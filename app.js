const express = require("express"),
  app = express(),
  server = require("http").Server(app),
  io = require("socket.io")(server),
  port = 3000,
  path = require("path"),
  bodyParser = require("body-parser"),
  thinkgear = require("node-thinkgear-sockets"),
  client = thinkgear.createClient({ enableRawOutput: false }),
  SerialPort = require("serialport"),
  sqlite3 = require("sqlite3"),
  fs = require("fs");

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
    db.run(
      "INSERT INTO users (name) VALUES (?)", e,
      function (err) {
        if (err) {
          console.error("Error inserting data:", err.message);
        } else {
          console.log(`Row inserted with ID: ${this.lastID}`);
        }
      }
    );
  });

  fs.readFile('selectedPort.json', (err, data) => {
    if (err) {
      console.error('Error reading selectedPort.json:', err);
    } else {
      const selectedPort = JSON.parse(data);
      socket.emit('selectedPortData', selectedPort);
    }

  });

  //To get COM port list.
  socket.on('getComList', () => {
    SerialPort.list().then(e => {
      io.emit('comPortList', e)
    });
  })

  //Sending selected COM to client.
  socket.on('selectedComPort', (selectedPort) => {
    fs.writeFile('selectedPort.json', JSON.stringify(selectedPort), (err) => {
      if (err) {
        console.error('Error writing selectedPort.json:', err);
      }
    });
  });

});

//For Selecting port from json file
fs.readFile('selectedPort.json', (err, data) => {
  if (err) {
    console.error('Error reading selectedPort.json:', err);
  } else {
    const selectedPort = JSON.parse(data);
    console.log(`Conneted to Com Port ${selectedPort}`);
    io.emit('selectedPortData', selectedPort);
    
    //Initializing Serial Port
    Readline = SerialPort.parsers.Readline;
    usbport = new SerialPort(selectedPort, {
      baudRate: 115200,
    });
    parser = usbport.pipe(new Readline());

    //Reading winner from serial port
    parser.on("data", function (data) {
      if (data == 1) {
        console.log("data from ardiono winner", data);
        io.emit("winnerTwo");
        console.log(`Emitted winnerTwo event`);

      }
    });

    //Reading data from MindWave headset, calculating speed based coming data and writing speed to serial port
    client.on("data", function (data) {
      var myobj = data;
      console.log(myobj.eSense.attention);
      var data = myobj.eSense.attention;
      io.emit("meditation", data);

      if (data > 0 && data <= 20) {
        usbport.write("a", function (err) {
          if (err) {
            return console.log("Error on write: ", err.message);
          }
          console.log("message written as " + "a");
        });
      }

      if (data > 20 && data <= 40) {
        usbport.write("b", function (err) {
          if (err) {
            return console.log("Error on write: ", err.message);
          }
          console.log("message written as " + "b");
        });
      }

      if (data > 40 && data <= 70) {
        usbport.write("c", function (err) {
          if (err) {
            return console.log("Error on write: ", err.message);
          }
          console.log("message written as " + "c");
        });
      }

      if (data > 70) {
        usbport.write("d", function (err) {
          if (err) {
            return console.log("Error on write: ", err.message);
          }
          console.log("message written as " + "d");
        });
      }

    });

  }
})

client.connect();