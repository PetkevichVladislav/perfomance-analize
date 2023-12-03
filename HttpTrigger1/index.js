const puppeteer = require("puppeteer");
const lighthouse = require('lighthouse');
const OpenAI = require('openai');
const axios = require('axios');

const OPEN_AI_KEY = process.env["OPEN_AI_KEY"];
const LOGIC_APP_URL = process.env["LOGIC_APP_URL"];

module.exports = async function (context, req) {
	context.log(`OPEN_AI_KEY value is not null: ${!(OPEN_AI_KEY === undefined || OPEN_AI_KEY === null)}`);
	context.log(`LOGIC_APP_URL value is not null: ${!(LOGIC_APP_URL === undefined || LOGIC_APP_URL === null)}`);
	var url = req.query.url || (req.body && req.body.url);
	var email = req.query.email || (req.body && req.body.email);
	context.log(`Analyzing URL ${url}`);

	try {
		var browser = await getBrowser(context);
		var report = await getLightHouseReport(context, browser, url);
		var prompt = createPromtFromReports(context, report, url);
		var recomendations = await generateOpenAIRecomendation(context, prompt);
		sendEmalWithReport(context, email, recomendations);
		context.res = {
			status: 200,
			body: null,
		};
	}
	catch (error) {
		context.error('Error during perfomance analise run:', error.message);

		context.res = {
			status: 500,
			body: error,
		};
	}
	finally {
		if(browser != null || browser !== undefined)
		{
			browser.disconnect();
			await browser.close();
		}
	}
};

async function getBrowser(context) {
	try {

		context.log("Start to create browser");
		// const options = {
		// 	headless: true,
		// 	args: ['--no-sandbox']
		// };
		var browser = await puppeteer.launch();

		context.log("Browser is created");

		return browser;
	} catch (error) {
		context.error('Error during creating browser:', error.message);
		throw error;
	}
}

async function getLightHouseReport(context, browser, url) {
	try {
		context.log("Start to generate lighthouse report");
		const { lhr } = await lighthouse(url, {
			port: new URL(browser.wsEndpoint()).port,
			output: 'json',
			logLevel: 'info',
			//onlyCategories: [ 'seo', 'performance', 'accessibility', 'best-practices' ]
		});

		context.log("Lighthouse report generated:" + lhr);
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
		context.log("Lighthouse report formated" + formattedReport);

		return formattedReport;
	} catch (error) {
		context.error('Error during Lighthouse run:', error.message);
		throw error;
	}
}

async function generateOpenAIRecomendation(context, prompt) {
	try {
		context.log("Start to create open ai recomendations:" + prompt);
		const openai = new OpenAI({
			apiKey: OPEN_AI_KEY,
		});
		var recomendations = await sendPromptToOpenAi(context, openai, prompt);
		context.log("Open ai recomendations created:" + recomendations);

		return recomendations;
	} catch (error) {
		context.error('Error during creating open ai recomendations:', error.message);
		throw error;
	}
}

async function sendPromptToOpenAi(context, openAiClient, prompt) {
	try {
		var response = await openAiClient.chat.completions.create({
			messages: [{ role: "system", content: prompt }],
			model: "gpt-3.5-turbo",
		});

		context.log("Getting result from open ai. Recomendations:" + response);
		return response.choices[0].message.content;
	}
	catch (error) {
		context.error("Open ai returned error:" + error);
		throw error;
	}
}

function createPromtFromReports(context, report, url) {
	try {
		context.log("Start to create prompt from report:" + report);

		var rerportAJson = JSON.stringify(report);
		var prompt = `Analise perfomance report and make list of suggestions base on the report: ${rerportAJson}. At the start of the messaage add message: Perfomance analise for web site: ${url} : `;

		context.log("Prompt created:" + prompt);
		return prompt;
	} catch (error) {
		context.error('Error during crating prompt:', error.message);
		throw error;
	}
}

async function sendEmalWithReport(context, email, body) {
	try {
		var jsonData = {
			email: email,
			report: body,
		};

		context.log("Start to sending report:" + jsonData);
		try {
			const response = await axios.post(LOGIC_APP_URL, jsonData);
			context.log("Response from sending request:" + response.status);
		} catch (error) {
			context.log(error);
		}
	} catch (error) {
		context.error('Error during seding report:', error.message);
		throw error;
	}
}

