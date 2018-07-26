let createError = require('http-errors');
let express = require('express');
let path = require('path');
let logger = require('morgan');
let bodyParser = require("body-parser");
let raspi = require("raspi");
let gpio = require('raspi-gpio');
let Serial = require("raspi-serial").Serial;
let async = require("async");
let isEqual = require('arraybuffer-equal');

const KEEP_ALIVE = new Uint8Array([0x10, 0x02, 0x01, 0x01, 0x00, 0x14, 0x10, 0x03]).buffer;
const UseCORS  = /^true$/i.test(process.env.CORS);
let device = process.env.DEVICE || "/dev/ttyAMA0";

raspi.init(()=> {

    let app = express();
    let logFormat = "'[:date[iso]] - :remote-addr - :method :url :status :response-time ms - :res[content-length]b'";
    app.use(logger(logFormat));
    app.use(bodyParser.text({type: '*/*'}));

    // catch 404 and forward to error handler
    app.use(function (req, res, next) {
        next(createError(404));
    });

    let serial = new Serial({
        portId: device,
        baudRate: 19200
    });

    const outputTX = new gpio.DigitalOutput({
        pin: 'GPIO8',
        pullResistor: gpio.PULL_DOWN
    });

    const outputRX = new gpio.DigitalOutput({
        pin: 'GPIO10',
        pullResistor: gpio.PULL_UP
    });

    const MAX_PACKET = 1024;
    let packet = new Uint8Array(MAX_PACKET);
    let packetSize = 0;
    let foundFirst = false;
    let foundSecond = false;
    let foundSecondLast = false;

    function handlePacket(packet) {
        if (!isEqual(packet.data, KEEP_ALIVE)) {
            console.log("Found packet with this data: " + packet);
        }
    }

    function handleByteReceived(value) {
        if (packetSize > MAX_PACKET) {
            console.log("Max packet size reached, dropping the following data: " + packet);
            packet = new Uint8Array(MAX_PACKET);
            packetSize = 0;
        }

        packet[packetSize++] = value;
        if (!foundFirst && value === 0x10) { // see if value is 0x10
            foundFirst = true; // if so, set it
        } // nothing to be done until we find the first 0x10
        else if (foundFirst && !foundSecond && value === 0x02) {  // found 0x10, see if next value is 0x02
            foundSecond = true; // it is, so set it
            if (packetSize !== 2) { // if we have more than 2 bytes in packet, then we likely had an error so handle the previous data
                handlePacket(packet.subarray(0, packetSize - 2)); // pull everything but the last 2 bytes and process them
                packet = packet.subarray(packetSize - 2, 2); // set packet to just the last two bytes
            }
        }
        else if (foundFirst && !foundSecond) { // if we found the 0x10, but the 2nd isn't 0x02
            foundFirst = false; // we really didn't find the start of packet, so start over
            console.log("Still looking for the first packet, so dropping the following data: " + packet);
            packet = new Uint8Array(MAX_PACKET);
            packetSize = 0;
        } // if foundFirst and foundSecond are both true, keep building up packet until we get the 0x10 0x03
        else if (foundFirst && foundSecond && value === 0x10) { // see if value is 0x10
            foundSecondLast = true; // if so (and foundFirst/Second), then we may have found the 2nd 0x10
        }
        else if (foundFirst && foundSecond && foundSecondLast && value === 0x03) { // check if the next byte is 0x03
            handlePacket(packet); // it is 0x03, so we've found a complete packet
            foundFirst = false; // reset the flags and packet
            foundSecond = false;
            foundSecondLast = false;
            packet = new Uint8Array(MAX_PACKET);
            packetSize = 0;
        }
        else if (foundFirst && foundSecond && foundSecondLast) { // the 0x10 was just in the packet, it was not an end packet indicator
            foundSecondLast = false; // so set this to false so we look for the 2nd 0x10 again
        }
    }

    serial.open(() => {
        let automationDetails = {};
        automationDetails.poolTemperature = "85 F";
        automationDetails.airTemperature = null;
        automationDetails.saltLevel = null;
        automationDetails.time = null;

        serial.on('data', function (data) {
            for (const value of data.values()) {
                handleByteReceived(value);
            }
        });

        UseCORS && app.use(function (req, res, next) {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
            next();
        });

        app.get('/pooltemp', function (req, res) {
            async.until(
                function () {
                    return typeof automationDetails.poolTemperature !== "undefined"
                },
                function (callback) {
                    setTimeout(callback, 10)
                },
                function () {
                    res.send(automationDetails.poolTemperature)
                }
            );
        });

        app.listen(process.env.PORT || 8181);
    });
});