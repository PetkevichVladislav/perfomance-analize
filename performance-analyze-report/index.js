let lighthouse;
import('lighthouse').then(module => {
	lighthouse = module.default;
});
require("puppeteer-core");
require('dotenv').config();
const puppeteer = require("puppeteer");
const OpenAI = require('openai');
const axios = require('axios');
const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');

const OPEN_AI_KEY = process.env["OPEN_AI_KEY"];
const BLOB_STORAGE_CONNECTION_STRING = process.env["BLOB_STORAGE_CONNECTION_STRING"];
const BLOB_STORAGE_CONTAINER_NAME = process.env["BLOB_STORAGE_CONTAINER_NAME"];
const DEVELOPER_RATE = process.env["DEVELOPER_RATE"];
const INCOME_COST_KOEFFICIENT = process.env["INCOME_COST_KOEFFICIENT"];

module.exports = async function (context, req) {
	context.log(`OPEN_AI_KEY value defined: ${!(OPEN_AI_KEY === undefined || OPEN_AI_KEY === null)}`);
	context.log(`BLOB_STORAGE_CONNECTION_STRING value defined: ${!(BLOB_STORAGE_CONNECTION_STRING === undefined || BLOB_STORAGE_CONNECTION_STRING === null)}`);
	var url = req.query.url || (req.body && req.body.url);
	var guid = req.query.guid || (req.body && req.body.guid);
	var pagePerVisit = req.query.pagePerVisit || (req.body && req.body.pagePerVisit);
	var adsPerPage = req.query.adsPerPage || (req.body && req.body.adsPerPage);
	var visitorQuanity = req.query.visitorQuanity || (req.body && req.body.visitorQuanity);
	context.log(`Analyzing URL ${url}`);

	try {
		var browser = await getBrowser(context);
		var aggregatedLighhouseReport = await getAggregatedLighhouseReport(context, browser, url, 1);
		var tasks = await generateOpenAiReport(context, aggregatedLighhouseReport);
		var money = calculateSavings(visitorQuanity, tasks.reduce((acc, item) => +item.gptEstimation + +acc, 0), pagePerVisit, adsPerPage, aggregatedLighhouseReport.savingMetrics.TBT, aggregatedLighhouseReport.savingMetrics.LCP);
		var result =
		{
			tasks: tasks,
			performance: calculateAverageMetric(aggregatedLighhouseReport.performance),
			accessibility: calculateAverageMetric(aggregatedLighhouseReport.accessibility),
			seo: calculateAverageMetric(aggregatedLighhouseReport.seo),
			savingMetrics: aggregatedLighhouseReport.savingMetrics,
			metrics: aggregatedLighhouseReport.metrics,
			bestPractices: aggregatedLighhouseReport.bestPractices,
			money: money,
		};
		await pushReportToStorage(context, JSON.stringify(result), guid);

		context.res = {
			status: 200,
			body: result,
		};
	}
	catch (error) {
		context.log.error('Error has been throwen during performance analyze run:', error.message);

		context.res = {
			status: 500,
			body: error,
		};
	}
	finally {
		if (browser != null || browser !== undefined) {
			await browser.close();
		}
	}
}

async function getBrowser(context) {
	try {
		context.log("Creating browser with puppeteer.");
		const options = {
			headless: true,
			args: ['--no-sandbox'],
		};

		var browser = await puppeteer.launch(options);
		context.log("Browser is created.");
		return browser;

	} catch (error) {
		context.log.error('Error during creating browser:', error.message);
		throw error;
	}
}

const calculateAverageMetric = arr => arr.reduce((p, c) => p + c, 0) / arr.length * 100;

async function pushReportToStorage(context, report, uniqueId) {
	try {
		const blobServiceClient = BlobServiceClient.fromConnectionString(BLOB_STORAGE_CONNECTION_STRING);
		const containerClient = blobServiceClient.getContainerClient(BLOB_STORAGE_CONTAINER_NAME);

		const fileName = `report_${uniqueId}.json`;
		const blobClient = containerClient.getBlockBlobClient(fileName);
		const uploadResponse = await blobClient.upload(report, report.length);
		context.log(`Report ${fileName} uploaded successfully`, uploadResponse.requestId);
	} catch (error) {
		context.log.error('Error during pushing blob to azure:', error.message);
		throw error;
	}
}

async function getAggregatedLighhouseReport(context, browser, url, quantityOfRuns) {
	try {
		const aggregatedReport =
		{
			performance: [],
			accessibility: [],
			seo: [],
			audits: [],
			savingMetrics: {},
			metrics: {}
		};

		const parameters = {
			port: new URL(browser.wsEndpoint()).port,
			output: 'json',
			logLevel: 'info',
		};

		for (let currentRun = 0; currentRun < quantityOfRuns; currentRun++) {
			context.log(`Start to generate lighthouse report for ${currentRun + 1} itteration`);
			var { lhr } = await lighthouse(url, parameters);
			context.log(`Lighthouse report for ${currentRun + 1} itteration generated:`);
			aggregatedReport.accessibility.push(lhr.categories.accessibility.score);
			aggregatedReport.performance.push(lhr.categories.performance.score);
			aggregatedReport.seo.push(lhr.categories.seo.score);
			aggregatedReport.bestPractices = lhr.categories['best-practices'].score;
			Object.values(lhr.audits).forEach(audit => {
				aggregatedReport.audits.push(audit);
			});
			context.log(`Lighthouse report result added to aggregated report for ${currentRun + 1} itteration`);
		}

		//distinct and sorting audits by score and id.
		aggregatedReport.audits = Object.values(aggregatedReport.audits.reduce((acc, audit) => ({ ...acc, [audit.id]: audit }), {}))
			.filter(audit => audit.guidanceLevel != null && audit.guidanceLevel != undefined)
			.sort((a, b) => b.guidanceLevel - a.guidanceLevel);

		const mainMetricIds = {
			'LCP': 'largest-contentful-paint-element',
			'TBT': 'total-blocking-time',
			'FCP': 'first-contentful-paint',
			'CLS': 'cumulative-layout-shift',
		};

		aggregatedReport.savingMetrics = aggregatedReport.audits
			.filter(item => item.guidanceLevel != undefined && item.metricSavings && !Object.values(mainMetricIds).includes(item.id))
			.reduce((acc, item) => {
				for (var metric in item.metricSavings) {
					acc[metric] = (acc[metric] || 0) + item.metricSavings[metric];
				};
				return acc;
			}, {});

		for (let key in mainMetricIds) {
			const metric = lhr.audits[mainMetricIds[key]];
			aggregatedReport.metrics[key] = metric ? metric.displayValue : undefined;
		}

		return aggregatedReport;
	} catch (error) {
		context.log.error('Error during Lighthouse run:', error.message);
		throw error;
	}
}

async function generateOpenAiReport(context, aggregatedLighthouseReport) {
	const delay = (time) => new Promise(res => setTimeout(res, time));
	let results = [];
	const openAiClient = new OpenAI({ apiKey: OPEN_AI_KEY, });
	for (let i = 0; i < aggregatedLighthouseReport.audits.length; i++) {
		let audit = aggregatedLighthouseReport.audits[i];
		try {
			auditResponse = await openAiClient.chat.completions.create({
				"model": "gpt-4-turbo-2024-04-09",
				"messages": preparePromptsForAuditRecomendation(JSON.stringify(audit)),
				"temperature": 0.7,
				"top_p": 1
			})

			await delay(100);

			estimationResponse = await openAiClient.chat.completions.create({
				"model": "gpt-4-turbo-2024-04-09",
				"messages": preparePromptsForAuditEstimation(auditResponse.choices[0].message.content),
				"temperature": 0.7,
				"top_p": 1
			})

			results.push({
				audit: audit,
				gptTaskDescription: auditResponse.choices[0].message.content,
				gptEstimation: estimationResponse.choices[0].message.content
			});
		} catch (error) {
			if (error.message.indexOf('429') !== -1) {
				i--; // retry this audit after waiting
				console.log('Rate limit reached. Waiting for 1s before retrying for itteration:' + i);
				await delay(1000);
			} else {
				results.push(null);
			}
		}
	}

	return results;
}

function preparePromptsForAuditRecomendation(audit) {
	var messages = [];
	messages.push({
		"role": "system",
		"content": "Act as Solution Architect in Performance testing. Please imagine that you need to generate a ticket for developers. Ticket must contains only  Ticket title, Ticket description, Ticket suggestions. Nothing else must not be included in the ticket. Ticket title must be informative, understandable. Ticket title must contain the next value from json file: displayValue. Ticket description must be constructed from the items specified in the json. First 10 item with data from headings (if there is) from json should be included as separate action items into the Ticket description. All action item should have description based on the numbers in json file. Ticket description must contain the concrete actions of what must be done based on the provided json. Description must contain information which you can be rephrased that the main focus is to optimize performance, make detailed analysis of findings and perform actions for optimization. Ticket suggestions must contain the concrete recommendations based on provided json. These recommendations must correlate with the description and title. Estimated impact must be focused on performance, finances and Revenue increase outcomes. Please generate the ticket using the requirements above and based on the json below."
	})
	messages.push({
		"role": "system",
		"content": audit
	})
	return messages;
}

function preparePromptsForAuditEstimation(auditRecomendation) {
	var messages = [];
	messages.push({
		"role": "system",
		"content": "Please estimate the created ticket in number of working days that require  for analysis and performing action items in the ticket. Team which work with ticket is one lead JS developer.  Take in account for estimations application complexity 8 from 10. Your reply must contain only number of total calculated estimations in working hours without and nothing else."
	})
	messages.push({
		"role": "user",
		"content": auditRecomendation
	});

	return messages;
}

function calculateSavings(visitorQuanity, tasksEstimation, pagePerVisit, adsPerPage, tbt, lcp) {
	const adsPerPageKoefficients = [1, 1.7, 2.4, 2.8, 3.4];
	const workCost = calculateWorkCost(tasksEstimation, DEVELOPER_RATE);
	const currentIncome = calculateCurrentIncome(30, visitorQuanity, pagePerVisit, getAdsPerVisitKoefficient(adsPerPageKoefficients, adsPerPage));
	const potentialIncomeIncrease = calculatePotentialIncomeIncrease(currentIncome, INCOME_COST_KOEFFICIENT, tbt)
	const potentialRevenueGain = calculatePotentialRevenueGain(lcp, INCOME_COST_KOEFFICIENT);

	return {
		workCost: workCost,
		potentialIncomeIncrease: potentialIncomeIncrease,
		potentialRevenueGain: potentialRevenueGain
	}
}

const calculateWorkCost = (estimation, developerRate) => estimation * developerRate;
const calculateCurrentIncome = (incomeKoefficient, visitorsQuantity, pagePerVisit, adsPerPageKoefficients) => incomeKoefficient * visitorsQuantity / 10000 * pagePerVisit * adsPerPageKoefficients * 12;
const calculatePotentialIncomeIncrease = (currentIncome, incomeCostKoefficient, tbt) => currentIncome * incomeCostKoefficient / 100 * tbt / 1000;
const calculatePotentialRevenueGain = (lcp, incomeCostKoefficient) => lcp / 1000 * incomeCostKoefficient;
const getAdsPerVisitKoefficient = (adsPerPageKoefficients, adsPerPage) => {
	if (adsPerPage > adsPerPageKoefficients.length) {
		return adsPerPageKoefficients[adsPerPageKoefficients.length - 1];
	}
	else {
		return adsPerPageKoefficients[adsPerPage - 1];
	}
}