const puppeteer = require('puppeteer');
const lighthouse = require('lighthouse');
const OpenAI = require('openai');
const axios = require('axios');

const OPEN_AI_KEY = process.env["OPEN_AI_KEY"];
const LOGIC_APP_URL = process.env["LOGIC_APP_URL"];

module.exports = async function (context, req) {
	const url = req.query.url || (req.body && req.body.url);
	const email = req.query.email || (req.body && req.body.email);
	context.log(`Analyzing URL ${url}`);

	try {
		var browser = await getBrowser();
		var report = await getLightHouseReport(browser, url);
		var prompt = createPromtFromReports(report, url);
		var recomendations = await generateOpenAIRecomendation(prompt);
		sendEmalWithReport(email, recomendations);
		context.res = {
			status: 200,
			body: null,
		};
	}
	catch (error) {
		console.error('Error during perfomance analise run:', error.message);
		
		context.res = {
			status: 500,
			body: error,
		};
	}
	finally {
		browser.disconnect();
		await browser.close();
	}
};

async function getBrowser() {
	console.log("Start to create browser");
	var browser = await puppeteer.launch({
		headless: true,
		timeout: 0,
		args: ['--no-sandbox']
	});

	console.log("Browser created");

	return browser;
}

async function getLightHouseReport(browser, url) {
	try {
		console.log("Start to generate lighthouse report");
		const { lhr } = await lighthouse(url, {
			port: new URL(browser.wsEndpoint()).port,
			output: 'json',
			logLevel: 'info',
			//onlyCategories: [ 'seo', 'performance', 'accessibility', 'best-practices' ]
		});

		console.log("Lighthouse report generated:" + lhr);
		const formattedReport =
		{
			performanceScore: lhr.categories.performance.score * 100,
			performance: lhr.categories.performance.score,
			accessibility: lhr.categories.accessibility.score,
			seo: lhr.categories.seo.score,
			pwa: lhr.categories.pwa.score,
			bestpractices: lhr.categories['best-practices'].score
			//audits: lhr.audits,
		};
		console.log("Lighthouse report formated" + formattedReport);

		return formattedReport;
	} catch (error) {
		console.error('Error during Lighthouse run:', error.message);
		throw error;
	}
}

async function generateOpenAIRecomendation(prompt) {
	console.log("Start to create open ai recomendations:" + prompt);
	const openai = new OpenAI({
		apiKey: OPEN_AI_KEY,
	});
	var recomendations = await sendPromptToOpenAi(openai, prompt);
	console.log("Open ai recomendations created:" + recomendations);

	return recomendations;
}

async function sendPromptToOpenAi(openAiClient, prompt) {
	try {
		const response = await openAiClient.chat.completions.create({
			messages: [{ role: "system", content: prompt }],
    		model: "gpt-3.5-turbo",
		});

		return response.choices[0].message.content;
	} catch (error) {
		console.log(error);
		throw "Enable to proccess results with AI.";
	}
}

function createPromtFromReports(report, url) {
	console.log("Start to create prompt from report:" + report);

	var rerportAJson = JSON.stringify(report);
	var prompt = `Analise perfomance report and make list of suggestions base on the report: ${rerportAJson}. At the start of the messaage add message: Perfomance analise for web site: ${url} : `;

	console.log("Prompt created:" + prompt);
	return prompt;
}

async function sendEmalWithReport(email, body) {
	var jsonData = {
		email: email,
		report: body,
	};

	console.log("Start to sending report:" + jsonData);
	try {
		const response = await axios.post(LOGIC_APP_URL, jsonData);
		console.log("Response from sending request:" + response.status);
	} catch (error) {
		console.log(error);
	}
}

