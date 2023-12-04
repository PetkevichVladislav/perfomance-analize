const puppeteer = require("puppeteer");
const lighthouse = require('lighthouse');
const OpenAI = require('openai');
const axios = require('axios');

const OPEN_AI_KEY = process.env["OPEN_AI_KEY"];
const LOGIC_APP_URL = process.env["LOGIC_APP_URL"];

module.exports = async function (context, req) {
	context.log(`OPEN_AI_KEY value defined: ${!(OPEN_AI_KEY === undefined || OPEN_AI_KEY === null)}`);
	context.log(`LOGIC_APP_URL value defined: ${!(LOGIC_APP_URL === undefined || LOGIC_APP_URL === null)}`);
	var url = req.query.url || (req.body && req.body.url);
	var email = req.query.email || (req.body && req.body.email);
	context.log(`Analyzing URL ${url}`);

	try {
		var browser = await getBrowser(context);
		var report = await getLightHouseReport(context, browser, url);
		var prompt = createPromptFromReports(context, report, url);
		var recommendations = await generateOpenAIRecommendation(context, prompt);
		sendEmailWithReport(context, email, recommendations);
		context.res = {
			status: 200,
			body: null,
		};
	}
	catch (error) {
		context.log.error('Error during performance analyze run:', error.message);

		context.res = {
			status: 500,
			body: error,
		};
	}
	finally {
		if (browser != null || browser !== undefined) {
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
		context.log.error('Error during creating browser:', error.message);
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
		context.log("Lighthouse report formatted" + formattedReport);

		return formattedReport;
	} catch (error) {
		context.log.error('Error during Lighthouse run:', error.message);
		throw error;
	}
}

async function generateOpenAIRecommendation(context, prompt) {
	try {
		context.log("Start to create open ai recommendations:" + prompt);
		const openAiClient = new OpenAI({
			apiKey: OPEN_AI_KEY,
		});
		var recommendations = await generateOpenAiRecommendations(context, openAiClient, prompt);
		context.log("Open ai recommendations created:" + recommendations);

		return recommendations;
	} catch (error) {
		context.log.error('Error during creating open ai recommendations:', error.message);
		throw error;
	}
}

async function generateOpenAiRecommendations(context, openAiClient, prompt) {
	try {
		var response = await openAiClient.chat.completions.create({
			messages: [{ role: "system", content: prompt }],
			model: "gpt-3.5-turbo",
		});

		context.log("Getting result from open ai. Recommendations:" + response);
		return response.choices[0].message.content;
	}
	catch (error) {
		context.log.error("Open ai endpoint returned error:" + error);
		throw error;
	}
}

function createPromptFromReports(context, report, url) {
	try {
		context.log("Start to create prompt from report:" + report);

		var reportAJson = JSON.stringify(report);
		var prompt = `Analyze performance report and make list of suggestions base on the report: ${reportAJson}. At the start of the message add message: Performance analyze for web site: ${url} : `;

		context.log("Prompt created:" + prompt);
		return prompt;
	} catch (error) {
		context.log.error('Error during crating prompt:', error.message);
		throw error;
	}
}

async function sendEmailWithReport(context, email, body) {
	try {
		var jsonData = {
			email: email,
			report: body,
		};

		context.log("Start to sending report:" + jsonData);
		const response = await axios.post(LOGIC_APP_URL, jsonData);
		context.log.error("Response from sending request:" + response);

	} catch (error) {
		context.log.error('Error during sending report:', error.message);
		throw error;
	}
}

