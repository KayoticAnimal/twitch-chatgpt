import express from 'express';
import fs from 'fs';
import ws from 'ws';
import expressWs from 'express-ws';
import { job } from './keep_alive.js';
import { OpenAIOperations } from './openai_operations.js';
import { TwitchBot } from './twitch_bot.js';

// Start keep-alive cron job
job.start();
console.log(process.env);

// Setup express app
const app = express();
const expressWsInstance = expressWs(app);

// Set the view engine to ejs
app.set('view engine', 'ejs');

// Load env variables
const GPT_MODE = process.env.GPT_MODE || "CHAT"; // CHAT or PROMPT
const HISTORY_LENGTH = process.env.HISTORY_LENGTH || 5; // number of messages to keep in history
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // OpenAI API key
const MODEL_NAME = process.env.MODEL_NAME || "gpt-3.5-turbo"; // OpenAI model name
const TWITCH_USER = process.env.TWITCH_USER; // Twitch bot username
const TWITCH_AUTH = process.env.TWITCH_AUTH; // TMI auth token
const COMMAND_NAME = (process.env.COMMAND_NAME || "!gpt").split(",").map(x => x.toLowerCase()); // Commands to trigger bot
const CHANNELS = (process.env.CHANNELS || "kayotic_animal").split(","); // Channels to join
const SEND_USERNAME = process.env.SEND_USERNAME || "true"; // Send username in message to OpenAI
const ENABLE_TTS = process.env.ENABLE_TTS || "false"; // Enable text to speech
const ENABLE_CHANNEL_POINTS = process.env.ENABLE_CHANNEL_POINTS || "false"; // Enable channel points

if (!OPENAI_API_KEY) {
    console.error("No OPENAI_API_KEY found. Please set it as environment variable.");
}
if (!TWITCH_USER) {
    console.error("No TWITCH_USER found. Please set it as environment variable.");
}
if (!TWITCH_AUTH) {
    console.error("No TWITCH_AUTH found. Please set it as environment variable.");
}

// Init global variables
const MAX_LENGTH = 399;
let file_context = "You are a helpful Twitch Chatbot.";

// Setup Twitch bot
console.log("Channels: " + CHANNELS);

const bot = new TwitchBot(TWITCH_USER, TWITCH_AUTH, CHANNELS, OPENAI_API_KEY, ENABLE_TTS);

// Setup OpenAI operations
file_context = fs.readFileSync("./file_context.txt", 'utf8');
const openai_ops = new OpenAIOperations(file_context, OPENAI_API_KEY, MODEL_NAME, HISTORY_LENGTH);

// Setup Twitch bot callbacks
bot.onConnected((addr, port) => {
    console.log(`* Connected to ${addr}:${port}`);
    CHANNELS.forEach(channel => {
        console.log(`* Joining ${channel}`);
        bot.say(channel, `Hello ${channel}! I am ${TWITCH_USER}, here to assist!`);
    });
});

bot.onDisconnected(reason => {
    console.log(`Disconnected: ${reason}`);
});

// Connect bot
bot.connect(
    () => {
        console.log("Bot connected!");
    },
    error => {
        console.log("Bot couldn't connect!");
        console.log(error);
    }
);

bot.onMessage(async (channel, user, message, self) => {
    if (self) return;
    
    console.log(`Received message from ${user.username}: ${message}`);

    if (ENABLE_CHANNEL_POINTS) {
        console.log(`The message id is ${user["msg-id"]}`);
        if (user["msg-id"] === "highlighted-message") {
            console.log(`The message is ${message}`);
            const response = await openai_ops.make_openai_call(message);
            console.log(`Responding with: ${response}`);
            bot.say(channel, response);
        }
    }

    if (COMMAND_NAME.some(command => message.toLowerCase().startsWith(command))) {
        console.log(`Command recognized: ${message}`);
        let text = message.slice(COMMAND_NAME.length);

        if (SEND_USERNAME === "true") {
            text = `Message from user ${user.username}: ${text}`;
        }

        // Make OpenAI call
        const response = await openai_ops.make_openai_call(text);

        console.log(`OpenAI response: ${response}`);

        // Split response if it exceeds Twitch chat message length limit
        // Send multiple messages with a delay in between
        if (response.length > MAX_LENGTH) {
            const messages = response.match(new RegExp(`.{1,${MAX_LENGTH}}`, "g"));
            messages.forEach((message, index) => {
                setTimeout(() => {
                    console.log(`Sending message part: ${message}`);
                    bot.say(channel, message);
                }, 1000 * index);
            });
        } else {
            console.log(`Sending message: ${response}`);
            bot.say(channel, response);
        }

        if (ENABLE_TTS === "true") {
            try {
                console.log(`${user.username} - ${user.userstate}`);
                const ttsAudioUrl = await bot.sayTTS(channel, response, user.userstate);
                notifyFileChange(ttsAudioUrl);
            } catch (error) {
                console.error(error);
            }
        }
    }
});

app.ws('/check-for-updates', (ws, req) => {
    ws.on('message', message => {
        // Handle WebSocket messages (if needed)
    });
});

// Setup bot
const messages = [
    { role: "system", content: "You are a helpful Twitch Chatbot." }
];

console.log("GPT_MODE is " + GPT_MODE);
console.log("History length is " + HISTORY_LENGTH);
console.log("OpenAI API Key:" + OPENAI_API_KEY);
console.log("Model Name:" + MODEL_NAME);

app.use(express.json({ extended: true, limit: '1mb' }));
app.use('/public', express.static('public'));

app.all('/', (req, res) => {
    console.log("Just got a request!");
    res.render('pages/index');
});

if (GPT_MODE === "CHAT") {
    fs.readFile("./file_context.txt", 'utf8', (err, data) => {
        if (err) throw err;
        console.log("Reading context file and adding it as system level message for the agent.");
        messages[0].content = data;
    });
} else {
    fs.readFile("./file_context.txt", 'utf8', (err, data) => {
        if (err) throw err;
        console.log("Reading context file and adding it in front of user prompts:");
        file_context = data;
        console.log(file_context);
    });
}

app.get('/gpt/:text', async (req, res) => {
    const text = req.params.text;

    const answer_question = async (answer) => {
        if (answer.length > MAX_LENGTH) {
            const messages = answer.match(new RegExp(`.{1,${MAX_LENGTH}}`, "g"));
            messages.forEach((message, index) => {
                setTimeout(() => {
                    bot.say(channel, message);
                }, 1000 * index);
            });
        } else {
            bot.say(channel, answer);
        }
    };

    let answer = "";
    if (GPT_MODE === "CHAT") {
        answer = await openai_ops.make_openai_call(text);
    } else if (GPT_MODE === "PROMPT") {
        let prompt = file_context;
        prompt += `\n\nUser: ${text}\nAgent:`;
        answer = await openai_ops.make_openai_call_completion(prompt);
    } else {
        console.log("ERROR: GPT_MODE is not set to CHAT or PROMPT. Please set it as environment variable.");
    }

    await answer_question(answer);

    res.send(answer);
});

const server = app.listen(3000, () => {
    console.log('Server running on port 3000');
});

const wss = expressWsInstance.getWss();

wss.on('connection', ws => {
    ws.on('message', message => {
        // Handle client messages (if needed)
    });
});

function notifyFileChange() {
    wss.clients.forEach(client => {
        if (client.readyState === ws.OPEN) {
            client.send(JSON.stringify({ updated: true }));
        }
    });
}
