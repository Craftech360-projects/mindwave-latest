const express = require("express"),
  app = express(),
  server = require("http").Server(app),
  io = require("socket.io")(server),
  port = 3000,
  path = require("path"),
  bodyParser = require("body-parser"),
  thinkgear = require("node-thinkgear-sockets"),
  client = thinkgear.createClient({ enableRawOutput: false }),
  SerialPort = require("serialport");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use("/asset", express.static(path.join(__dirname, "asset")));

server.listen(port, () => console.log("Server listening on " + port));

io.on("connection", function (socket) {
  console.log("conncted");
});

//Initializing Serial Port
Readline = SerialPort.parsers.Readline;
usbport = new SerialPort('COM5', {
  baudRate: 115200,
});
parser = usbport.pipe(new Readline());

//Reading winner from serial port
parser.on("data", function (data) {
  if (data == 1) {
    console.log("data from ardiono winner");
    io.emit("winnerOne");
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

client.connect();
