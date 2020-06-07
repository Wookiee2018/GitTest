# meraki-icu - Cisco Meraki MV Camera MQTT ALPR/ANPR and Amazon AWS Rekognition

meraki-icu is the second version of meraki-mqtt-alpr.

meraki-icu is a node.js application with subscribes or consumes the MQTT notifications from second generation Cisco
Meraki MV cameras via an MQTT broker and processes vehicle and people detection events.

In the case of people detections it can save a still snapshot and use Amazon AWS Rekognition to determine a persons
gender, age range and emotional state.  Examples of cameras that support this include MV12, MV22, MV32 and MV72.

In the case of vehicle detections (from an MV72 camera only) meraki-icu can use a cloud based image to licence plate
server - either platerecognizer.com or openalpr.com.  I found platerecognizer substantially better, cheaper, and
also comes with a lot more free lookups so you can have a bigger play without spending any money.
They call these services ALPR or ANPR depending where in the world you come from.  If platerecognizer.com is used
and you are based in New Zealand the number then you can enable an option to lookup the number plate in the New
Zealand Police stolen vehicles database to see if the vehicle is stolen.

This script assumes all cameras are in a single Meraki organisation and a single network within that organisation.

Refer to http://www.ifm.net.nz/cookbooks/meraki-icu.html for installation instructions.
