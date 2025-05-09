import OpenAI from "openai";
import 'dotenv/config';
import express from 'express';
import ExpressWs from 'express-ws';
import crypto from 'crypto';

import twilio from 'twilio';
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
ExpressWs(app);


///////////////

const PORT = process.env.PORT || 3002;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

////// Firebase Stuff /////
import { getDatabase, ref, update, serverTimestamp, get } from "firebase/database";
import admin from "firebase-admin";
// import serviceAccount from "./service-account-key.json" assert {type: "json"}; // local
import serviceAccount from "/etc/secrets/service-account-key.json" with { type: "json" }; // deployment

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL // database URL
});

const db = admin.database(); // Get a database reference
////////////////////////////////

function hashPhoneNumber(number) {
  const salt = 'apples_are_not_yellow'; // Generate or store a unique salt
  const saltedPhoneNumber = number + salt;
  return crypto.createHash('sha256').update(saltedPhoneNumber).digest('hex');
}

async function checkForExistingThread(userId) {
  // Preform query in firebase
  console.log("in the check for existing thread function, cr-server: ", userId)
  let data;
  try {
    const userRef = ref(db, `users/${userId}/profile`);
    const result = await get(userRef)
    const data = result.val()
    console.log("data from firebase (cr-server.js): ", data)
    // delete old OpenAI assistant: data.assistantId
    if (data) {
      await openai.beta.assistants.del(data.assistantId)
      return data.thread;
    } else {
      return false;
    }
  } catch (err) {
    console.error("Issue pulling user data from firebase: ", err)
  }
}

app.post('/voice', async (req, res) => {
  const response = new VoiceResponse();
  const connect = response.connect();
  const caller = req.body.From
  console.log("caller: ", caller)
  const userId = hashPhoneNumber(caller)

  // get the voice from firebase:
  let data;
  try {
    const userRef = ref(db, `users/${userId}/profile`);
    const result = await get(userRef)
    data = result.val();
  } catch (err) {
    console.error("Issue pulling user data from firebase: ", err)
  }
  let voiceId = data.voiceId;
  console.log("here's the data: ", data)

  const loadingMessage = [
    "Hi there Let me finish up my snack I'll be right there give me 4 seconds",
    "Hello there three seconds please",
    "Let me finish the last of my tea and then we can talk",
    "Well well I must be popular my phone is ringing off the hook I will be right with you in a moment",
  ]

  connect.conversationRelay({
    url: "wss://owlvin-ai-server-js-692351747341.us-west1.run.app/connection", //deployed > "wss://6bd61a7d7052.ngrok.app/connection", // dev
    ttsProvider: 'Elevenlabs',
    transcriptionProvider: "Deepgram",
    speechModel: "nova-2-general",
    voice: voiceId,
    interruptible: "none",
    welcomeGreeting: loadingMessage[Math.floor(Math.random() * loadingMessage.length)],
    welcomeGreetingInterruptible: "none",
  });

  res.type('text/xml');
  res.send(response.toString());
});

app.post('/create-assistant', async (req, res) => {
  console.log("the request body from cr-service.js: ", req.body)
  let userId = hashPhoneNumber(req.body.phoneNumber);
  let topic = req.body.topic;
  let personality = req.body.personality;
  let tone = req.body.tone;
  let voiceId;
  switch (tone) {
    case "Technical":
      voiceId = "D9Thk1W7FRMgiOhy3zVI"
      break;
    case "Casual":
      voiceId = "IjnA9kwZJHJ20Fp7Vmy6"
      break;
    case "Ironic":
      voiceId = "54Cze5LrTSyLgbO6Fhlc"
      break;
    default: // Sarcastic
      voiceId = "5e3JKXK83vvgQqBcdUol"
  }
  console.log("the voiceId selected: ", voiceId)
  const prompt = `You are a chat bot who will discuss ${topic} with the caller. 
Never include punctuation or exclamation marks in your responses. 
You have a very strong ${personality} personality and you incorporate that personality in each response. 
Keep responses short, no more than 1 sentence, and always end each response with a question. 
Feel free to discuss anything discussed in previous chats.`

  /////////// Create a new assistant with OpenAI ////////////////
  let assistant;

  try {
    assistant = await openai.beta.assistants.create({
      name: `signal_activation_${userId}`,
      instructions: prompt,
      model: "gpt-4o-mini",
      temperature: 0.75
    });
  } catch (err) {
    console.error("Issue creating profile: ", err);
    return res.status(500).send("Issue creating assistant");
  }

  if (!assistant || !assistant.id) {
    console.log("Assistant ID not immediately available. Waiting...");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const assistantId = assistant.id;
  /////////////////////////////////////////////////////////


  ///////// Thread Check Logic //////////////////////////////
  let thread;
  try {
    thread = await checkForExistingThread(userId)
  } catch (err) {
    console.error("Issue checking for existing thread: ", err)
  }

  // Check for an existing thread. If one exist, use it. If not, create one.
  if (!thread) {
    try {
      thread = await openai.beta.threads.create();
      console.log("new thread created")
    } catch (err) {
      console.error("issue creating thread: ", err)
    }
  }
  ////////////////////////////////////////////////////////////

  const dbRef = ref(db);
  const path = `users/${userId}/profile/`
  const profileDetails = {
    assistantId,
    thread,
    lastUsed: serverTimestamp(),
    active: true,
    voiceId
  }

  try {
    await update(dbRef, {
      [path]: profileDetails
    })
    console.log("profile created in firebase")
  } catch (err) {
    console.error("Issue creating profile in firebase")
  }

  res.send(200, "good")

})


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});