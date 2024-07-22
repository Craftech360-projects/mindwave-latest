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

client.on("data", function (data) {
  var myobj = data;
  console.log(myobj.eSense.attention);
  var data = myobj.eSense.attention;
  io.emit("meditation", data);
});

client.connect();