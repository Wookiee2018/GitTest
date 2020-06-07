/* meraki-icu
 *
 * meraki-icu is the second version of meraki-mqtt-alpr.
 *
 * meraki-icu is a node.js application with subscribes or consumes the MQTT notifications from second generation Cisco
 * Meraki MV cameras via an MQTT broker and processes vehicle and people detection events.
 *
 * In the case of people detections it can save a still snapshot and use Amazon AWS Rekognition to determine a persons
 * gender, age range and emotional state.  Examples of cameras that support this include MV12, MV22, MV32 and MV72.
 *
 * In the case of vehicle detections (from an MV72 camera only) meraki-icu can use a cloud based image to licence plate
 * server - either platerecognizer.com or openalpr.com.  I found platerecognizer substantially better, cheaper, and
 * also comes with a lot more free lookups so you can have a bigger play without spending any money.
 * They call these services ALPR or ANPR depending where in the world you come from.  If platerecognizer.com is used
 * and you are based in New Zealand the number then you can enable an option to lookup the number plate in the New
 * Zealand Police stolen vehicles database to see if the vehicle is stolen.
 *
 * This script assumes all cameras are in a single Meraki organisation and a single network within that organisation.
 *
 * Refer to http://www.ifm.net.nz/cookbooks/meraki-icu.html for installation instructions.
 *
 *
 * The original project was written by Philip D'Ath (pid@ifm.net.nz) from IFM NZ Ltd (www.ifm.net.nz).
 * http://www.ifm.net.nz/cookbooks/meraki-icu.html
 *
 * History:
 * When:				Who:	What:
 * 27-Dec-2019	PID		Upgraded from meraki-mqtt-alpr.  Converted to using the node.js Meraki SDK.
 *										Removed all config from code and put into seperate config files, .meraki.env and .env.
 *										Added support for Amazon AWS Rekognition for people detection events.
 * 25-Feb-2020	PID		AWS is now only initialised if it is enabled.
 */

'use strict';


const os = require('os');
const path = require('path')

// Load in the credentials from .env - you can copy .env.example to .env to get started.
require('dotenv').config()
require('dotenv').config({ path: path.join(os.homedir(),'.meraki.env') })

if(!(process.env.x_cisco_meraki_api_key && process.env.orgName && process.env.networkName))
throw("The .env file is missing or incomplete.  You can copy .env.example to .env to get started.  You must fill in the three Meraki configuration values.");

// Set to true to enable console logging debugging
const debug=(process.env.debug && process.env.debug.toUpperCase()=="TRUE" ? true : false)

// Set to true to check the NZ Police stolen vehicle database
const useNZStolen=(process.env.useNZStolen && process.env.useNZStolen.toUpperCase()=="TRUE" ? true : false)

// Set to true to use platerecognizer.com
const usePR=(process.env.usePR && process.env.usePR.toUpperCase()=="TRUE" ? true : false)

// Set to true to use openalpr.com
const useOpenALPR=(process.env.useOpenALPR && process.env.useOpenALPR.toUpperCase()=="TRUE" ? true : false)

// Set to true to save images in vehicles/ and people/ subdirectories.  Make sure you create a scheduled task
// to clean these out every so often.
const useSaveImages=(process.env.useSaveImages && process.env.useSaveImages.toUpperCase()=="TRUE" ? true : false)

// Set to true to use Amazon AWS Rekognition
const useAWSRekognition=(process.env.useAWSRekognition && process.env.useAWSRekognition.toUpperCase()=="TRUE" ? true : false)

// Initialise the Meraki dashboard environment
const meraki = require('meraki');
const configuration = meraki.Configuration;
configuration.xCiscoMerakiAPIKey = process.env.x_cisco_meraki_api_key;
configuration.BASEURI="https://api-mp.meraki.com/api/v0"  // The current node.js SDK has a bug with POST functions.  This is a work around.

// Used for processing images
const axios = require('axios');
const fs = require('fs');

// Connect to the MQTT broker, but we don't enable message processing till later on
const mqtt = require('mqtt')
const mqttClient = mqtt.connect('mqtt://127.0.0.1')

// Used for Amazon AWS Rekognition
let awsRekognition;
if(useAWSRekognition) try {
	process.env.AWS_SDK_LOAD_CONFIG="true"
	awsRekognition = require('aws-sdk/clients/rekognition');
} catch (error) {
	console.error('aws-sdk: Either your credentials file or your config file is missing.  Try running "aws configure"');
	console.error("aws-sdk: "+error);
	process.exit(-1)
}

// Used to send images to platerecognizer.com
const FormData = require('form-data');

// Used to check the NZ Police stolen vehicles database
const nzpsvdb = require('nzpsvdb');

var orgID;
var netID;
var people = {}; // The last time stamp for each camera we have received a person count message for
var vehicles = {}; // The last time stamp for each camera we have received a vehicle count message for

// This function does nothing
const noop = () => {};

// Ask platerecognizer.com what the plate is
const processPlateRecognizer = function(cameraSerial,ts,image) {
	if(debug) console.log("processPlateRecognizer:");

	let form = new FormData();

	form.append("upload",image,{
		filename: 'vehicle.jpg'
	});
	form.append("camera_id",cameraSerial);
	form.append("timestamp",ts);
//	form.append("regions",process.env.country);

	axios.request({
		method: "post",
		url: 'https://api.platerecognizer.com/v1/plate-reader',
		data: form,
		headers: {
			'Authorization': 'Token '+process.env.plateRecognizerAPIToken,
			'Content-Type': `multipart/form-data; boundary=${form._boundary}`
		}
	}).then(function (response) {
		let results=response.data.results;
		if(results.length) {
			var plate=results[0].plate.toUpperCase();

			// We got a number plate we can read
			console.log("processPlateRecognizer: plate="+plate+", GMT timestamp="+new Date(ts).toISOString())

			// If enabled, check the NZ stolen plate register
			if(useNZStolen && nzpsvdb.stolen(results[0].plate))
				console.log("*** STOLEN VEHICLE DETECTED *** : "+plate+", GMT timestamp="+new Date(ts).toISOString());
		}
	})
	.catch(function (error) {
		console.error("processPlateRecognizer: "+error);
	});
}

// Call OpenALPR and ask it what the plate is
const processOpenALPR = function(cameraSerial,ts,image) {
	if(debug) console.log("processOpenALPR:");

	axios.request({
		url: 'https://api.openalpr.com/v2/recognize_bytes?recognize_vehicle=0&country='+process.env.country+'&topn=1&secret_key='+process.env.openALPRsecret,
		method: "post",
		headers: {
			'Content-Type': 'image/jpeg',
		},
		data: image.toString('base64')
	}).then(function (response) {
		// Process the openalpr.com response here
		if(response.data.results.length>0) {
			// We got a number plate we can read
			console.log("processOpenALPR: plate="+response.data.results[0].plate+", GMT timestamp="+new Date(ts).toISOString())
		}
	})
	.catch(function (error) {
		console.error("processOpenALPR: "+error)
	});
}

// Call Amazon AWS Rekognition to find out about the person
const processAWSRekognition = function(cameraSerial,ts,image) {
	if(debug) console.log("processAWSRekognition:");

	const awsClient = new awsRekognition();

	// This is called once detectFaces returns
  const internalCallback = function cb(error, response) {
		if(error) {
			console.error("processAWSRekognition:internalCallback: "+error)
			return;
		}		

		// Process the Amazon AWS Rekognition response here.  The full range of response values can be found at this link:
		// https://docs.aws.amazon.com/rekognition/latest/dg/faces-detect-images.html#w696aac27c19b6b6b2c11
		response.FaceDetails.forEach(data => {
			console.log("processAWSRekognition:internalCallback: I'm "+Math.round(data.Gender.Confidence)+"% confident I just saw a "+data.Gender.Value+" between "+data.AgeRange.Low+" and "+data.AgeRange.High+" years old.")
			console.log("processAWSRekognition:internalCallback: They seemed to display these emotions:")

			data.Emotions.forEach(emotion => {
				if(emotion.Confidence>50) console.log(emotion.Type+" ("+Math.round(emotion.Confidence)+"% confident)")
			})

			//console.log("processAWSRekognition:internalCallback: "+JSON.stringify(data))
		})
	}

	// Ask AWS to detect faces
	awsClient.detectFaces({
		"Image": {
			'Bytes': image
		},
		Attributes: ['ALL']}, internalCallback)
}


// This gets called when a vehicle has been detected
const processVehicle = function(cameraSerial,ts,image) {
	if(debug) console.log("processVehicle: cameraSerial="+cameraSerial+", ts="+ts);

	// If enabled, save the images
	if(useSaveImages) {
		let now=new Date().toISOString().replace(/:/, '-').replace(/:/, '-')
		fs.writeFile("vehicles/"+now+".jpg", response.data, noop);
	}

	// If enabled, use the ALPR engines (typically would only use one)
	if(useOpenALPR) processOpenALPR(cameraSerial,ts,image);
	if(usePR) processPlateRecognizer(cameraSerial,ts,image);
}

// This gets called when a person has been detected
const processPerson = function(cameraSerial,ts,image) {
	if(debug) console.log("processPerson: cameraSerial="+cameraSerial+", ts="+ts);

	// If enabled, save the images
	if(useSaveImages) {
		let now=new Date().toISOString().replace(/:/, '-').replace(/:/, '-')
		fs.writeFile("people/"+now+".jpg", image, noop);
	}

	// If enabled, use Amazon AWS Rekognition
	if(useAWSRekognition) processAWSRekognition(cameraSerial,ts,image);
}

// Request the image from the snapshot and keep trying until we get it
const processSnapshotImage = function(cameraSerial,ts,process,url,count) {
	if(debug) console.log("processSnapshotImage: "+url+", count="+count);

	// If we can't get the image from the URL after 30 attempts then give up
	if(count>30) {
		console.log("processSnapshotImage: could not retrieve image after 30 attempts: "+url);
		return;
	}

	// Download the image from the person detection
	axios.request({
		url: url,
		method: "get",
		responseType: "arraybuffer",
		headers: {
			'Content-Type': 'image/jpeg',
		}
	}).then(function (response) {
		process(cameraSerial,ts,response.data)
	})
	.catch(function (error) {
		if(typeof error.response ==='undefined') {
			console.error("processSnapshotImage: "+error)
		}
		else if (error.response.status == 'undefined') {
			console.error("processSnapshotImage: "+error)
		}
		else if (error.response.status === 404) {
			// If a 404 got returned then we need to wait a bit longer for the image to be ready
			setTimeout(processSnapshotImage, 2000, cameraSerial, ts, process,url,count+1)
		}
		else if (error.response.status >= 500 && error.response.status<=599) {
			console.error("processSnapshotImage: server error="+error.response.status+", "+error.response.statusText+", url="+url)			
		}
		else console.error("processSnapshotImage: "+error);
	});
}

// Request a snapshot and keep retrying until it is ready
const processSnapshot = function(netID, cameraSerial,ts,process,count) {
	if(debug) console.log("processSnapshot: netID="+netID+", camera serial="+cameraSerial+",ts="+ts+", count="+count);

	// If we can't get the snapshot API for the URL after 10 attempts then give up
	if(count>10) {
		console.log("processSnapshot: could not process snapshot after 10 attempts");
		return;
	}

	const model=new meraki.GenerateNetworkCameraSnapshotModel({timestamp:ts})
	meraki.CamerasController.generateNetworkCameraSnapshot({networkId:netID,serial:cameraSerial,generateNetworkCameraSnapshot:model})
		.then(data => setTimeout(processSnapshotImage,5000,cameraSerial,ts,process,data.url,0))
		.catch(error => setTimeout(processSnapshot,Math.random()*30000+1000,netID,cameraSerial,ts,process,count+1));
}

// Connect to the MQTT broker and say what we are interested in
const mqttConnect = function() {
	if(debug) console.log("mqttConnect:");

	if(!process.env.mqttCameras) throw new Error("mqttConnect: mqttCameras not defined in .env - no cameras to process.");

	// Loop through the list of cameras
	for(let camera of process.env.mqttCameras.split(","))
	{ 
		if(debug) console.log("mqttConnect: subscribe to "+camera);
		mqttClient.subscribe(camera)
	}
}


/* This gets called when there is a message for us to process.
 *
 * Sample topic and message
 * /merakimv/Q2GV-xxxx-xxxx/0 {"ts":1572567835359, "counts":{"person":0}}
 * /merakimv/Q2JV-xxxx-xxxx/0 {"ts":1572567835571, "counts":{"vehicle":0}}
 */
const mqttMessage = function(topic, message) {
 	if (debug) console.log("mqttMessage: "+topic + " " + message)

 	var topicArray=topic.split("/");

	// Only process meraki mv camera events that have a topic we are expecting
	if(topicArray.length !== 4) return;
	if(topicArray[1] !== "merakimv") return;
	if(topicArray[3] !== "0") return;

	// Camera serial number
	var cameraSerial=topicArray[2];

	// The message is in json format
	var data=JSON.parse(message);
	var ts=data.ts;	// The time stamp for when this event happened

	if (debug) console.log("mqttMessage: netID="+netID+", Camera serial="+cameraSerial+", timestamp="+ts);

	if(typeof data.counts.person !== 'undefined' && data.counts.person>0) {
		// A person was walked into frame
		if (debug) console.log("mqttMessage: people count: "+data.counts.person);

		// See if we have had a message from this camera in the last 500ms
		{
			let lastts=people[cameraSerial];

			if (lastts && ts<lastts+500) return;
			people[cameraSerial]=ts;
		}

//		setTimeout(processSnapshot, 60000, netID, cameraSerial,new Date(ts).toISOString(),processPerson,0)
		processSnapshot(netID, cameraSerial,new Date(ts).toISOString(),processPerson,0);
  	}
	if(typeof data.counts.vehicle !== 'undefined' && data.counts.vehicle>0) {
		// A vehicle was driven into frame
		if (debug) console.log("vehicle count: "+data.counts.vehicle);

		// See if we have had a message from this camera in the last 500ms
		{
			let lastts=vehicles[cameraSerial];

			if (lastts && ts<lastts+500) return;
			vehicles[cameraSerial]=ts;
		}

//		setTimeout(processVehicle, 60000, netID, cameraSerial,new Date(ts).toISOString(),processVehicle,0)
		processSnapshot(netID, cameraSerial,new Date(ts).toISOString(),processVehicle,0);
	}
}

// This searchs a list of Meraki networks for the ID matching the network name globally defined
const findNet = function(netList) {
	for(var i = 0; i < netList.length; i++) {
		if (netList[i].name === process.env.networkName) {
			netID=netList[i].id;

			if (debug) console.log("netID="+netID);
			return;
		}
	}
	throw new Error("Could not find network");
}


// This searchs a list of Meraki orgsfor the ID matching the orgname globally defined
const findOrg = function (orgList) {
	for(var i = 0; i < orgList.length; i++) {
		if (orgList[i].name === process.env.orgName) {
			orgID=orgList[i].id;

			if (debug) console.log("orgID="+orgID);
			return;
		}
	}
	throw new Error("Could not find organisation");
}

const main = async function(netList) {

	try {
		mqttClient.on('connect', mqttConnect);

		// Load the NZ stolen vehicles database into memory.  Note we don't wait for this to finish.
		if(useNZStolen) nzpsvdb.load();

		findOrg(await meraki.OrganizationsController.getOrganizations());
		findNet(await meraki.NetworksController.getOrganizationNetworks({organizationId:orgID}));

		console.log("main: Finished initializing, starting to process camera messages.");

		mqttClient.on('message', mqttMessage);
	} catch (error) {
		mqttClient.end();
		console.error("main: "+JSON.stringify(error));
	}
}

main();
