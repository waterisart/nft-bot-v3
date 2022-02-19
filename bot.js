// ------------------------------------
// 1. DEPENDENCIES
// ------------------------------------

const dotenv = require("dotenv");

// Load base .env file first
dotenv.config();

// If there's a specific NODE_ENV set, attempt to load that environment specific .env file
if(process.env.NODE_ENV) {
	const environmentSpecificFile = `.env.${process.env.NODE_ENV}`;
	const fs = require("fs");

	if(fs.existsSync(environmentSpecificFile)) {
		dotenv.config({
			path: environmentSpecificFile,
			override: true
		});	
	}
}

const express = require('express');
const app = express();
const server = require('http').createServer(app);
const Web3 = require("web3");
const WebSocket = require('ws');
const fetch = require('node-fetch');
const abis = require('./abis');

// -----------------------------------------
// 2. GLOBAL VARIABLES
// -----------------------------------------

let allowedLink = false, currentlySelectedWeb3ProviderIndex = -1, eventSubTrading = null, eventSubCallbacks = null, nonce = null,
	providers = [], web3 = [], maxPriorityFeePerGas = 50,
	openTrades = [], spreadsP = [], openInterests = [], collaterals = [], nfts = [], nftsBeingUsed = [], ordersTriggered = [],
	storageContract, tradingContract, tradingAddress, callbacksContract, vaultContract, pairsStorageContract, nftRewardsContract,
	nftTimelock, maxTradesPerPair,
	nftContract1, nftContract2, nftContract3, nftContract4, nftContract5, linkContract;

// --------------------------------------------
// 3. INIT: CHECK ENV VARS & LINK ALLOWANCE
// --------------------------------------------

console.log("Welcome to the gTrade NFT bot!");
if(!process.env.WSS_URLS || !process.env.PRICES_URL || !process.env.STORAGE_ADDRESS
|| !process.env.PRIVATE_KEY || !process.env.PUBLIC_KEY || !process.env.EVENT_CONFIRMATIONS_SEC 
|| !process.env.TRIGGER_TIMEOUT || !process.env.MAX_GAS_PRICE_GWEI || !process.env.CHECK_REFILL_SEC 
|| !process.env.VAULT_REFILL_ENABLED || !process.env.AUTO_HARVEST_SEC || !process.env.MIN_PRIORITY_GWEI
|| !process.env.PRIORITY_GWEI_MULTIPLIER){
	console.log("Please fill all parameters in the .env file.");
	process.exit();
}

// Parse non-string configuration constants from environment variables up front
const MAX_GAS_PRICE_GWEI = parseInt(process.env.MAX_GAS_PRICE_GWEI, 10),
	  CHECK_REFILL_SEC = parseInt(process.env.CHECK_REFILL_SEC, 10),
	  EVENT_CONFIRMATIONS_SEC = parseInt(process.env.EVENT_CONFIRMATIONS_SEC, 10),
	  TRIGGER_TIMEOUT = parseInt(process.env.TRIGGER_TIMEOUT, 10),
	  AUTO_HARVEST_SEC = parseInt(process.env.AUTO_HARVEST_SEC, 10);

async function checkLinkAllowance(){
	web3[currentlySelectedWeb3ProviderIndex].eth.net.isListening().then(async () => {
		const allowance = await linkContract.methods.allowance(process.env.PUBLIC_KEY, process.env.STORAGE_ADDRESS).call();
		if(parseFloat(allowance) > 0){
			allowedLink = true;
			console.log("LINK allowance OK.");
		}else{
			console.log("LINK not allowed, approving now.");

			const tx = {
				from: process.env.PUBLIC_KEY,
				to : linkContract.options.address,
				data : linkContract.methods.approve(process.env.STORAGE_ADDRESS, "115792089237316195423570985008687907853269984665640564039457584007913129639935").encodeABI(),
				maxPriorityFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(maxPriorityFeePerGas*1e9),
				maxFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(MAX_GAS_PRICE_GWEI*1e9),
				gas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex("100000")
			};

			web3[currentlySelectedWeb3ProviderIndex].eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY).then(signed => {
				web3[currentlySelectedWeb3ProviderIndex].eth.sendSignedTransaction(signed.rawTransaction)
				.on('receipt', () => {
					console.log("LINK successfully approved.");
					allowedLink = true;
				}).on('error', (e) => {
					console.log("LINK approve tx fail (" + e + ")");
					setTimeout(() => { checkLinkAllowance(); }, 2*1000);
				});
			}).catch(e => {
				console.log("LINK approve tx fail (" + e + ")");
				setTimeout(() => { checkLinkAllowance(); }, 2*1000);
			});
		}
	}).catch(() => {
		setTimeout(() => { checkLinkAllowance(); }, 5*1000);
	});
}

// -----------------------------------------
// 4. WEB3 PROVIDER
// -----------------------------------------

const WEB3_PROVIDER_URLS = process.env.WSS_URLS.split(",");
let currentWeb3ProviderBlocks = new Array(WEB3_PROVIDER_URLS.length).fill(0);

async function selectProvider(newProviderIndex){
	console.log("Selecting new provider...");
	
	const executionStartTime = Date.now();

	// Unsubscribe from existing events first
	if(eventSubTrading !== null && eventSubTrading.id !== null){ eventSubTrading.unsubscribe(); }
	if(eventSubCallbacks !== null && eventSubCallbacks.id !== null){ eventSubCallbacks.unsubscribe(); }
	eventSubTrading = null;
	eventSubCallbacks = null;
	
	storageContract = new web3[newProviderIndex].eth.Contract(abis.STORAGE, process.env.STORAGE_ADDRESS);

	// Retrieve all necessary details from the storage contract
	const [
		aggregatorAddress,
		callbacksAddress,
		tradingAddress,
		vaultAddress,
		nftAddress1,
		nftAddress2,
		nftAddress3,
		nftAddress4,
		nftAddress5,
		linkAddress
	] = await Promise.all([
		storageContract.methods.priceAggregator().call(),
		storageContract.methods.callbacks().call(),
		storageContract.methods.trading().call(),
		storageContract.methods.vault().call(),
		storageContract.methods.nfts(0).call(),
		storageContract.methods.nfts(1).call(),
		storageContract.methods.nfts(2).call(),
		storageContract.methods.nfts(3).call(),
		storageContract.methods.nfts(4).call(),
		storageContract.methods.linkErc677().call()
	]);

	const aggregatorContract = new web3[newProviderIndex].eth.Contract(abis.AGGREGATOR, aggregatorAddress);
	
	// Retrieve all necessary details from the aggregator contract
	const [
		pairsStorageAddress,
		nftRewardsAddress
	 ] = await Promise.all([
		aggregatorContract.methods.pairsStorage().call(),
		aggregatorContract.methods.nftRewards().call()
	 ]);
	
	pairsStorageContract = new web3[newProviderIndex].eth.Contract(abis.PAIRS_STORAGE, pairsStorageAddress);
	nftRewardsContract = new web3[newProviderIndex].eth.Contract(abis.NFT_REWARDS, nftRewardsAddress);

	callbacksContract = new web3[newProviderIndex].eth.Contract(abis.CALLBACKS, callbacksAddress);
	tradingContract = new web3[newProviderIndex].eth.Contract(abis.TRADING, tradingAddress);
	vaultContract = new web3[newProviderIndex].eth.Contract(abis.VAULT, vaultAddress);

	nftContract1 = new web3[newProviderIndex].eth.Contract(abis.NFT, nftAddress1);
	nftContract2 = new web3[newProviderIndex].eth.Contract(abis.NFT, nftAddress2);
	nftContract3 = new web3[newProviderIndex].eth.Contract(abis.NFT, nftAddress3);
	nftContract4 = new web3[newProviderIndex].eth.Contract(abis.NFT, nftAddress4);
	nftContract5 = new web3[newProviderIndex].eth.Contract(abis.NFT, nftAddress5);

	linkContract = new web3[newProviderIndex].eth.Contract(abis.LINK, linkAddress);

	// Update the globally selected provider with this new provider
	currentlySelectedWeb3ProviderIndex = newProviderIndex;
	
	// Subscribe to events using the new provider
	watchLiveTradingEvents();
	
	// Fire and forget refreshing of data using new provider
	fetchTradingVariables();
	fetchOpenTrades();
	checkLinkAllowance();
	
	console.log("New provider selection completed. Took: " + (Date.now() - executionStartTime) + "ms");
}

const getProvider = (wssId) => {
	const provider = new Web3.providers.WebsocketProvider(WEB3_PROVIDER_URLS[wssId], {clientConfig:{keepalive:true,keepaliveInterval:30*1000}});

	provider.on('close', () => {
		setTimeout(() => {
			if(!provider.connected){
				console.log(WEB3_PROVIDER_URLS[wssId]+' closed: trying to reconnect...');

				let connectedProvider = -1;
				for(var i = 0; i < WEB3_PROVIDER_URLS.length; i++){
					if(providers[i].connected){
						connectedProvider = i;
						break;
					}
				}
				if(connectedProvider > -1 && currentlySelectedWeb3ProviderIndex === wssId){
					selectProvider(connectedProvider);
					console.log("Switched to WSS " + WEB3_PROVIDER_URLS[currentlySelectedWeb3ProviderIndex]);
				}else if(connectedProvider === -1 && currentlySelectedWeb3ProviderIndex === wssId){
					console.log("No WSS to switch to...");
				}

				providers[wssId] = getProvider(wssId);
				web3[wssId] = new Web3(providers[wssId]);
			}
		}, 1*1000);
	});

	provider.on('connect', () => {
		if(provider.connected){
			console.log('Connected to WSS '+WEB3_PROVIDER_URLS[wssId]+'.');
		}
	});
	provider.on('error', () => { console.log("WSS "+WEB3_PROVIDER_URLS[wssId]+" error"); provider.disconnect(); });
	return provider;
};

for(var i = 0; i < WEB3_PROVIDER_URLS.length; i++){
	const provider = getProvider(i);
	providers.push(provider);
	web3.push(new Web3(provider));
}

// TODO: consider making this a config value
const MAX_PROVIDER_BLOCK_DRIFT = 5;

async function checkWeb3ProviderLiveness() {
	console.log("Checking liveness of all " + WEB3_PROVIDER_URLS.length + " web3 provider(s)...");

	const executionStartTime = Date.now();

	const latestWeb3ProviderBlocks = await Promise.all(WEB3_PROVIDER_URLS.map(async (wssUrl, wssIndex) => {
		try
		{
			return await web3[wssIndex].eth.getBlockNumber();
		} catch (error) {
			console.log("Error retrieving current block number from provider " + wssUrl + ": " + error.message, error);

			return Number.MIN_SAFE_INTEGER;
		}
	}));
	
	console.log("Current vs. latest provider blocks: ", WEB3_PROVIDER_URLS, currentWeb3ProviderBlocks, latestWeb3ProviderBlocks);

	// Update global to latest blocks
	currentWeb3ProviderBlocks = latestWeb3ProviderBlocks;

	const originalWeb3ProviderIndex = currentlySelectedWeb3ProviderIndex;

	// Check if no provider has been selected yet (i.e. this is initialization phase of app)
	if(originalWeb3ProviderIndex === -1){
		await selectInitialProvider();
	} else {
		await ensureCurrentlySelectedProviderHasLatestBlock();
	}

	console.log("Web3 provider liveness check completed. Took: " + (Date.now() - executionStartTime) + "ms");

	async function selectInitialProvider() {
		// Find the most recent block
		const maxProviderBlock = Math.max(...currentWeb3ProviderBlocks);
		
		const providerIndex = currentWeb3ProviderBlocks.findIndex(v => v === maxProviderBlock);
		
		// Start with the provider with the most recent block
		await selectProvider(providerIndex);

		console.log("Initial provider selected: " + WEB3_PROVIDER_URLS[providerIndex]);
	}

	async function ensureCurrentlySelectedProviderHasLatestBlock() {
		const currentlySelectedWeb3ProviderIndexMaxDriftBlock = currentWeb3ProviderBlocks[currentlySelectedWeb3ProviderIndex] + MAX_PROVIDER_BLOCK_DRIFT;
		
		for(let i = 0; i < currentWeb3ProviderBlocks.length; i++){
			// Don't check the currently selected provider against itself
			if(i === currentlySelectedWeb3ProviderIndex) {
				continue;
			}
			
			// If the current provider is ahead of the selected provider by more N blocks then switch to this provider instead
			if(currentWeb3ProviderBlocks[i] >= currentlySelectedWeb3ProviderIndexMaxDriftBlock){
				console.log("Switching to provider " + WEB3_PROVIDER_URLS[i] + " #" + i + " (" + currentWeb3ProviderBlocks[i] + " vs " + currentWeb3ProviderBlocks[currentlySelectedWeb3ProviderIndex] + ")");
				
				await selectProvider(i);
				
				break;
			}
		}

		if(currentlySelectedWeb3ProviderIndex === originalWeb3ProviderIndex) {
			console.log("No need to switch to a different provider; sticking with " + WEB3_PROVIDER_URLS[currentlySelectedWeb3ProviderIndex] + ".");
		} else {
			console.log("Switched to provider " + WEB3_PROVIDER_URLS[currentlySelectedWeb3ProviderIndex] + " completed.");
		}
	}
}

checkWeb3ProviderLiveness();
setInterval(async () => {
	checkWeb3ProviderLiveness();
}, 10*1000);

setInterval(() => {
	console.log("Current WSS: " + web3[currentlySelectedWeb3ProviderIndex].currentProvider.url + " (#"+currentlySelectedWeb3ProviderIndex+")");
}, 120*1000);

// -----------------------------------------
// 5. FETCH DYNAMIC GAS PRICE
// -----------------------------------------

setInterval(() => {
	fetch("https://gasstation-mainnet.matic.network/v2/").then(r => r.json()).then((r) => {
		maxPriorityFeePerGas = Math.round(
			Math.max(
				Math.round(r.fast.maxPriorityFee) * process.env.PRIORITY_GWEI_MULTIPLIER, 
				process.env.MIN_PRIORITY_GWEI
			)
		);
	}).catch(() => { console.log("Error while fetching fastest gwei from gas station.") });
}, 3*1000);

// -----------------------------------------
// 6. FETCH PAIRS, NFTS, AND NFT TIMELOCK
// -----------------------------------------

async function fetchTradingVariables(){
	web3[currentlySelectedWeb3ProviderIndex].eth.net.isListening().then(async () => {
		const maxPerPair = await storageContract.methods.maxTradesPerPair().call();
		const nftSuccessTimelock = await storageContract.methods.nftSuccessTimelock().call();
		const pairsCount = await pairsStorageContract.methods.pairsCount().call();
		nfts = [];

		const nftsCount1 = await nftContract1.methods.balanceOf(process.env.PUBLIC_KEY).call();
		const nftsCount2 = await nftContract2.methods.balanceOf(process.env.PUBLIC_KEY).call();
		const nftsCount3 = await nftContract3.methods.balanceOf(process.env.PUBLIC_KEY).call();
		const nftsCount4 = await nftContract4.methods.balanceOf(process.env.PUBLIC_KEY).call();
		const nftsCount5 = await nftContract5.methods.balanceOf(process.env.PUBLIC_KEY).call();

		for(var i = 0; i < nftsCount1; i++){
			const id = await nftContract1.methods.tokenOfOwnerByIndex(process.env.PUBLIC_KEY, i).call();
			nfts.push({id: id, type: 1});
		}
		for(var i = 0; i < nftsCount2; i++){
			const id = await nftContract2.methods.tokenOfOwnerByIndex(process.env.PUBLIC_KEY, i).call();
			nfts.push({id: id, type: 2});
		}
		for(var i = 0; i < nftsCount3; i++){
			const id = await nftContract3.methods.tokenOfOwnerByIndex(process.env.PUBLIC_KEY, i).call();
			nfts.push({id: id, type: 3});
		}
		for(var i = 0; i < nftsCount4; i++){
			const id = await nftContract4.methods.tokenOfOwnerByIndex(process.env.PUBLIC_KEY, i).call();
			nfts.push({id: id, type: 4});
		}
		for(var i = 0; i < nftsCount5; i++){
			const id = await nftContract5.methods.tokenOfOwnerByIndex(process.env.PUBLIC_KEY, i).call();
			nfts.push({id: id, type: 5});
		}

		let pairsPromises = [];
		for(var i = 0; i < pairsCount; i++){
			pairsPromises.push(pairsStorageContract.methods.pairsBackend(i).call());
		}

		Promise.all(pairsPromises).then(async (s) => {
			for(var j = 0; j < s.length; j++){
				const openInterestLong = await storageContract.methods.openInterestDai(j, 0).call();
				const openInterestShort = await storageContract.methods.openInterestDai(j, 1).call();
				const openInterestMax = await storageContract.methods.openInterestDai(j, 2).call();
				openInterests[j] = {long: openInterestLong, short: openInterestShort, max: openInterestMax};

				const collateralLong = await pairsStorageContract.methods.groupsCollaterals(j, 0).call();
				const collateralShort = await pairsStorageContract.methods.groupsCollaterals(j, 1).call();
				const collateralMax = await pairsStorageContract.methods.groupMaxCollateral(j).call();
				collaterals[j] = {long: collateralLong, short: collateralShort, max: collateralMax};
			}

			spreadsP = [];
			for(var j = 0; j < s.length; j++){ spreadsP.push(s[j]["0"].spreadP); }

			nftTimelock = nftSuccessTimelock;
			maxTradesPerPair = maxPerPair;

			console.log("Fetched trading variables.");
		});
	}).catch(() => {
		setTimeout(() => { fetchTradingVariables(); }, 2*1000);
	});
}

setInterval(() => {
	fetchTradingVariables();
	fetchOpenTrades();
}, 60*5*1000);

// -----------------------------------------
// 7. SELECT NFT TO EXECUTE ORDERS
// -----------------------------------------

async function selectNft(){
	return new Promise(async resolve => {
		if(nftTimelock === undefined || nfts.length === 0){ resolve(null); return; }
		
		web3[currentlySelectedWeb3ProviderIndex].eth.net.isListening().then(async () => {
			const currentBlock = await web3[currentlySelectedWeb3ProviderIndex].eth.getBlockNumber();

			for(var i = 0; i < nfts.length; i++){
				const lastSuccess = await storageContract.methods.nftLastSuccess(nfts[i].id).call();
				if(parseFloat(currentBlock) - parseFloat(lastSuccess) >= nftTimelock
				&& !nftsBeingUsed.includes(nfts[i].id)){
					//console.log("Selected NFT #" + nfts[i].id);
					resolve(nfts[i]);
					return;
				}
			}

			console.log("No suitable NFT to select.");
			resolve(null);

		}).catch(() => {
			resolve(null);
		});
	});
}

// -----------------------------------------
// 8. LOAD OPEN TRADES
// -----------------------------------------

async function fetchOpenTrades(){
	web3[currentlySelectedWeb3ProviderIndex].eth.net.isListening().then(async () => {

		if(spreadsP.length === 0){
			setTimeout(() => { fetchOpenTrades(); }, 2*1000);
			return;
		}

		openTrades = [];

		let openLimitOrdersTypesPromises = [];
		const openLimitOrders = await storageContract.methods.getOpenLimitOrders().call();
		for(let i = 0; i < openLimitOrders.length; i++){
			const l = openLimitOrders[i];
			openLimitOrdersTypesPromises.push(nftRewardsContract.methods.openLimitOrderTypes(l.trader, l.pairIndex, l.index).call());
		}

		let promisesPairTradersArray = [];
		for(let i = 0; i < spreadsP.length; i++){
			promisesPairTradersArray.push(storageContract.methods.pairTradersArray(i).call());
		}

		Promise.all(openLimitOrdersTypesPromises).then(async (l) => {
			for(let j = 0; j < l.length; j++){
				openTrades.push({...openLimitOrders[j], type: l[j]});
			}

			Promise.all(promisesPairTradersArray).then(async (r) => {
				let promisesTrade = [];

				for(let j = 0; j < r.length; j ++){
					for(let a = 0; a < r[j].length; a++){
						for(let b = 0; b < maxTradesPerPair; b++){
							promisesTrade.push(storageContract.methods.openTrades(r[j][a], j, b).call());
						}
					}
				}

				Promise.all(promisesTrade).then((trades) => {
					for(let j = 0; j < trades.length; j++){
						if(trades[j].leverage.toString() === "0"){ continue; }
						openTrades.push(trades[j]);
					}

					console.log("Fetched open trades: " + openTrades.length);
				});
			});
		});
	}).catch(() => {
		setTimeout(() => { fetchOpenTrades(); }, 2*1000);
	});
}
// -----------------------------------------
// 9. WATCH TRADING EVENTS
// -----------------------------------------

function watchLiveTradingEvents(){
	web3[currentlySelectedWeb3ProviderIndex].eth.net.isListening().then(async () => {
		if(eventSubTrading === null){
			eventSubTrading = tradingContract.events.allEvents({ fromBlock: 'latest' }).on('data', function (event){
				const eventName = event.event.toString();

				if(eventName !== "OpenLimitPlaced" && eventName !== "OpenLimitUpdated"
				&& eventName !== "OpenLimitCanceled" && eventName !== "TpUpdated"
				&& eventName !== "SlUpdated"){
					return;
				}

				event.triedTimes = 1;

				setTimeout(() => {
					refreshOpenTrades(event);
				}, EVENT_CONFIRMATIONS_SEC*1000);
			});
		}

		if(eventSubCallbacks === null){
			eventSubCallbacks = callbacksContract.events.allEvents({ fromBlock: 'latest' }).on('data', function (event){
				const eventName = event.event.toString();

				if(eventName !== "MarketExecuted" && eventName !== "LimitExecuted"
				&& eventName !== "MarketCloseCanceled" && eventName !== "SlUpdated" 
				&& eventName !== "SlCanceled"){
					return;
				}

				event.triedTimes = 1;

				setTimeout(() => {
					refreshOpenTrades(event);
				}, EVENT_CONFIRMATIONS_SEC*1000);
			});
		}
	}).catch(() => {
		setTimeout(() => { watchLiveTradingEvents(); }, 2*1000);
	});
}

// -----------------------------------------
// 10. REFRESH INTERNAL OPEN TRADES LIST
// -----------------------------------------

async function refreshOpenTrades(event){
	web3[currentlySelectedWeb3ProviderIndex].eth.net.isListening().then(async () => {
		const eventName = event.event.toString();
		const v = event.returnValues;
		let failed = false;

		// UNREGISTER OPEN LIMIT ORDER
		// => IF OPEN LIMIT CANCELED OR OPEN LIMIT EXECUTED
		if(eventName === "OpenLimitCanceled" 
		|| (eventName === "LimitExecuted" && v.orderType.toString() === "3")){

			const trader = eventName === "OpenLimitCanceled" ? v.trader : v.t[0];
			const pairIndex = eventName === "OpenLimitCanceled" ? v.pairIndex : v.t[1];
			const index = eventName === "OpenLimitCanceled" ? v.index : v.limitIndex;

			const hasLimitOrder = await storageContract.methods.hasOpenLimitOrder(trader, pairIndex, index).call();

			if(hasLimitOrder.toString() === "false"){

				for(var i = 0; i < openTrades.length; i++){

					if(openTrades[i].trader === trader 
					&& openTrades[i].pairIndex === pairIndex
					&& openTrades[i].index === index
					&& openTrades[i].hasOwnProperty('minPrice')){

						openTrades[i] = openTrades[openTrades.length-1];
						openTrades.pop();

						console.log("Watch events ("+eventName+"): Removed limit");
						break;
					}
				}
			}else{
				failed = true;
			}
		}

		// STORE/UPDATE OPEN LIMIT ORDER
		// => IF OPEN LIMIT ORDER PLACED OR OPEN LIMIT ORDER UPDATED
		if(eventName === "OpenLimitPlaced" 
		|| eventName === "OpenLimitUpdated"){

			const hasLimitOrder = await storageContract.methods.hasOpenLimitOrder(v.trader, v.pairIndex, v.index).call();

			if(hasLimitOrder.toString() === "true"){

				const id = await storageContract.methods.openLimitOrderIds(v.trader, v.pairIndex, v.index).call();
				const limit = await storageContract.methods.openLimitOrders(id).call();
				let found = false;

				const type = await nftRewardsContract.methods.openLimitOrderTypes(v.trader, v.pairIndex, v.index).call();
				limit.type = type;

				for(var i = 0; i < openTrades.length; i++){

					if(openTrades[i].trader === v.trader 
					&& openTrades[i].pairIndex === v.pairIndex
					&& openTrades[i].index === v.index
					&& openTrades[i].hasOwnProperty('minPrice')){

						openTrades[i] = limit;
						found = true;

						console.log("Watch events ("+eventName+"): Updated limit");
						break;
					}
				}

				if(!found){ 
					openTrades.push(limit); 
					console.log("Watch events ("+eventName+"): Stored limit");
				}
			}else{
				failed = true;
			}
		}

		// STORE/UPDATE TRADE
		// => IF MARKET OPEN EXECUTED OR OPEN TRADE LIMIT EXECUTED OR TP/SL UPDATED OR TRADE UPDATED (MARKET CLOSED)
		if((eventName === "MarketExecuted" && v.open.toString() === "true") 
		|| (eventName === "LimitExecuted" && v.orderType.toString() === "3")
		|| eventName === "TpUpdated" || eventName === "SlUpdated" || eventName === "SlCanceled"
		|| eventName === "MarketCloseCanceled"){

			const trader = eventName !== "MarketExecuted" && eventName !== "LimitExecuted" ? v.trader : v.t[0];
			const pairIndex = eventName !== "MarketExecuted" && eventName !== "LimitExecuted" ? v.pairIndex : v.t[1];
			const index = eventName !== "MarketExecuted" && eventName !== "LimitExecuted" ? v.index : v.t[2];

			const trade = await storageContract.methods.openTrades(trader, pairIndex, index).call();
			
			if(parseFloat(trade.leverage) > 0){
				let found = false;

				for(var i = 0; i < openTrades.length; i++){

					if(openTrades[i] !== undefined
					&& openTrades[i].trader === trader 
					&& openTrades[i].pairIndex === pairIndex
					&& openTrades[i].index === index 
					&& openTrades[i].hasOwnProperty('openPrice')){

						openTrades[i] = trade;
						found = true;

						console.log("Watch events ("+eventName+"): Updated trade");
						break;
					}
				}

				if(!found){ 
					openTrades.push(trade); 
					console.log("Watch events ("+eventName+"): Stored trade");
				}
			}else{
				failed = true;
			}
		}

		// UNREGISTER TRADE
		// => IF MARKET CLOSE EXECUTED OR CLOSE LIMIT EXECUTED
		if((eventName === "MarketExecuted" && v.open.toString() === "false") 
		|| (eventName === "LimitExecuted" && v.orderType !== "3")){

			const trade = await storageContract.methods.openTrades(v.t[0], v.t[1], v.t[2]).call();

			if(parseFloat(trade.leverage) === 0){
				for(var i = 0; i < openTrades.length; i++){

					if(openTrades[i] !== undefined
					&& openTrades[i].trader === v.t[0] 
					&& openTrades[i].pairIndex === v.t[1]
					&& openTrades[i].index === v.t[2] 
					&& openTrades[i].hasOwnProperty('openPrice')){

						openTrades[i] = openTrades[openTrades.length-1];
						openTrades.pop();

						console.log("Watch events ("+eventName+"): Removed trade");
						break;
					}
				}
			}else{
				failed = true;
			}
		}
		if(failed){

			if(event.triedTimes == 10){ return; }
			event.triedTimes ++;

			setTimeout(() => {
				refreshOpenTrades(event);
			}, EVENT_CONFIRMATIONS_SEC*1000);

			console.log("Watch events ("+eventName+"): Trade not found on the blockchain, trying again in "+(EVENT_CONFIRMATIONS_SEC/2)+" seconds.");
		}
	}).catch((e) => { console.log("Problem when refreshing trades", e); });
}

// ---------------------------------------------
// 11. FETCH CURRENT PRICES & TRIGGER ORDERS
// ---------------------------------------------

function alreadyTriggered(trade, orderType){
	for(var i = 0; i < ordersTriggered.length; i++){
		if(ordersTriggered[i].orderType === orderType){
			const t = ordersTriggered[i].trade;
			if(trade.trader === t.trader && trade.pairIndex === t.pairIndex && trade.index === t.index){
				return true;
			}
		}
	}
	return false;
}

let forexMarketClosed = false;

setInterval(() => {
	const d = new Date();
	const v = d.getUTCDay();    
	const h = d.getUTCHours();
	const dom = d.getUTCDate();
	const mon = d.getUTCMonth();

	forexMarketClosed = (mon === 11 && dom >= 25 && dom <= 27) || (mon === 0 && dom >= 1 && dom <= 3) || 
						(v === 5 && h >= 21) || (v === 6) || (v === 0 && h < 21);
}, 5000);

function wss(){
	let socket = new WebSocket(process.env.PRICES_URL);
	socket.onclose = () => { setTimeout(() => { wss() }, 2000); };
	socket.onerror = () => { socket.close(); };
	socket.onmessage = async (msg) => {
		const p = JSON.parse(msg.data);
		if(p.closes === undefined) return;
		
		if(spreadsP.length > 0 && allowedLink){

			for(var i = 0; i < openTrades.length; i++){

				const t = openTrades[i];

				if(forexMarketClosed && t.pairIndex >= 21 && t.pairIndex <= 30) continue;

				const price = p.closes[t.pairIndex];
				const buy = t.buy.toString() === "true";
				let orderType = -1;

				if(t.openPrice !== undefined){

					const tp = parseFloat(t.tp)/1e10;
					const sl = parseFloat(t.sl)/1e10;
					const open = parseFloat(t.openPrice)/1e10;
					const lev = parseFloat(t.leverage);
					const liqPrice = buy ? open - 0.9/lev*open : open + 0.9/lev*open;

					if(tp.toString() !== "0" && ((buy && price >= tp) || (!buy && price <= tp))){
						orderType = 0;
					}else if(sl.toString() !== "0" && ((buy && price <= sl) || (!buy && price >= sl))){
						orderType = 1;
					}else if(sl.toString() === "0" && ((buy && price <= liqPrice) || (!buy && price >= liqPrice))){
						orderType = 2;
					}

				}else{

					const spread = spreadsP[t.pairIndex]/1e10*(100-t.spreadReductionP)/100;
					const priceIncludingSpread = !buy ? price*(1-spread/100) : price*(1+spread/100);
					const interestDai = buy ? parseFloat(openInterests[t.pairIndex].long) : parseFloat(openInterests[t.pairIndex].short);
					const collateralDai = buy ? parseFloat(collaterals[t.pairIndex].long) : parseFloat(collaterals[t.pairIndex].short);
					const newInterestDai = (interestDai + parseFloat(t.leverage)*parseFloat(t.positionSize));
					const newCollateralDai = (collateralDai + parseFloat(t.positionSize));
					const maxInterestDai = parseFloat(openInterests[t.pairIndex].max);
					const maxCollateralDai = parseFloat(collaterals[t.pairIndex].max);
					const minPrice = parseFloat(t.minPrice)/1e10;
					const maxPrice = parseFloat(t.maxPrice)/1e10;

					if(newInterestDai <= maxInterestDai && newCollateralDai <= maxCollateralDai){
						if(t.type.toString() === "0" && priceIncludingSpread >= minPrice && priceIncludingSpread <= maxPrice
						|| t.type.toString() === "1" && (buy ? priceIncludingSpread <= maxPrice : priceIncludingSpread >= minPrice)
						|| t.type.toString() === "2" && (buy ? priceIncludingSpread >= minPrice : priceIncludingSpread <= maxPrice)){
							orderType = 3;
						}
					}
				}

				if(orderType > -1 && !alreadyTriggered(t, orderType)){

					const nft = await selectNft();
					if(nft === null){ return; }

					const orderInfo = {nftId: nft.id, trade: t, type: orderType,
						name: orderType === 0 ? "TP" : orderType === 1 ? "SL" : orderType === 2 ? "LIQ" : "OPEN"};

					//console.log("Try to trigger (order type: " + orderInfo.name + ", nft id: "+orderInfo.nftId+")");

					tradingContract.methods.executeNftOrder(orderType, t.trader, t.pairIndex, t.index, nft.id, nft.type)
					.estimateGas({from: process.env.PUBLIC_KEY}, (error, result) => {
						if(error){
							console.log("Tx error (order type: " + orderInfo.name + ", nft id: "+orderInfo.nftId+"), not triggering: ", error.message);
						}else{
							if(alreadyTriggered(t, orderType) || nftsBeingUsed.includes(nft.id)) return;

							nftsBeingUsed.push(nft.id);
							ordersTriggered.push({trade: t, orderType: orderType});

							const tx = {
								from: process.env.PUBLIC_KEY,
								to : tradingAddress,
								data : tradingContract.methods.executeNftOrder(orderType, t.trader, t.pairIndex, t.index, nft.id, nft.type).encodeABI(),
								maxPriorityFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(maxPriorityFeePerGas*1e9),
								maxFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(MAX_GAS_PRICE_GWEI*1e9),
								gas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex("2000000")
							};

							web3[currentlySelectedWeb3ProviderIndex].eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY).then(signed => {
								web3[currentlySelectedWeb3ProviderIndex].eth.sendSignedTransaction(signed.rawTransaction)
								.on('receipt', () => {
									console.log("Triggered (order type: " + orderInfo.name + ", nft id: "+orderInfo.nftId+")");
									setTimeout(() => {
										ordersTriggered = ordersTriggered.filter(item => JSON.stringify(item) !== JSON.stringify({trade:orderInfo.trade, orderType: orderInfo.type}));
										nftsBeingUsed = nftsBeingUsed.filter(item => item !== orderInfo.nftId);
									}, TRIGGER_TIMEOUT*1000);
								}).on('error', (e) => {
									console.log("Failed to trigger (order type: " + orderInfo.name + ", nft id: "+orderInfo.nftId+")");
									//console.log("Tx error (" + e + ")");
									setTimeout(() => {
										ordersTriggered = ordersTriggered.filter(item => JSON.stringify(item) !== JSON.stringify({trade:orderInfo.trade, orderType: orderInfo.type}));
										nftsBeingUsed = nftsBeingUsed.filter(item => item !== orderInfo.nftId);
									}, TRIGGER_TIMEOUT*1000);
								});
							}).catch(e => {
								console.log("Failed to trigger (order type: " + orderInfo.name + ", nft id: "+orderInfo.nftId+")");
								//console.log("Tx error (" + e + ")");
								setTimeout(() => {
									ordersTriggered = ordersTriggered.filter(item => JSON.stringify(item) !== JSON.stringify({trade:orderInfo.trade, orderType: orderInfo.type}));
									nftsBeingUsed = nftsBeingUsed.filter(item => item !== orderInfo.nftId);
								}, TRIGGER_TIMEOUT*1000);
							});
						}
					});
				}
			}
		}
	};
}

wss();

// ------------------------------------------
// 12. REFILL VAULT IF CAN BE REFILLED
// ------------------------------------------

if(process.env.VAULT_REFILL_ENABLED){
	async function refill(){
		vaultContract.methods.refill().estimateGas({from: process.env.PUBLIC_KEY}, (error, result) => {
			if(!error){
				const tx = {
					from: process.env.PUBLIC_KEY,
					to : vaultContract.options.address,
					data : vaultContract.methods.refill().encodeABI(),
					maxPriorityFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(maxPriorityFeePerGas*1e9),
					maxFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(MAX_GAS_PRICE_GWEI*1e9),
					gas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex("1000000")
				};

				web3[currentlySelectedWeb3ProviderIndex].eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY).then(signed => {
					web3[currentlySelectedWeb3ProviderIndex].eth.sendSignedTransaction(signed.rawTransaction)
					.on('receipt', () => {
						console.log("Vault successfully refilled.");
					}).on('error', (e) => {
						console.log("Vault refill tx fail", e);
					});
				}).catch(e => {
					console.log("Vault refill tx fail", e);
				});
			}
		});
	}

	async function deplete(){
		vaultContract.methods.deplete().estimateGas({from: process.env.PUBLIC_KEY}, (error, result) => {
			if(!error){
				const tx = {
					from: process.env.PUBLIC_KEY,
					to : vaultContract.options.address,
					data : vaultContract.methods.deplete().encodeABI(),
					maxPriorityFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(maxPriorityFeePerGas*1e9),
					maxFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(MAX_GAS_PRICE_GWEI*1e9),
					gas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex("1000000")
				};

				web3[currentlySelectedWeb3ProviderIndex].eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY).then(signed => {
					web3[currentlySelectedWeb3ProviderIndex].eth.sendSignedTransaction(signed.rawTransaction)
					.on('receipt', () => {
						console.log("Vault successfully depleted.");
					}).on('error', (e) => {
						console.log("Vault deplete tx fail", e);
					});
				}).catch(e => {
					console.log("Vault deplete tx fail", e);
				});
			}
		});
	}

	setInterval(() => {
		refill();
		deplete();
	}, CHECK_REFILL_SEC*1000);
}

// ------------------------------------------
// 13. AUTO HARVEST REWARDS
// ------------------------------------------

if(AUTO_HARVEST_SEC > 0){
	async function claimTokens(){
		nftRewardsContract.methods.claimTokens().estimateGas({from: process.env.PUBLIC_KEY}, (error, result) => {
			if(!error){
				const tx = {
					from: process.env.PUBLIC_KEY,
					to : nftRewardsContract.options.address,
					data : nftRewardsContract.methods.claimTokens().encodeABI(),
					maxPriorityFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(maxPriorityFeePerGas*1e9),
					maxFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(MAX_GAS_PRICE_GWEI*1e9),
					gas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex("1000000")
				};

				web3[currentlySelectedWeb3ProviderIndex].eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY).then(signed => {
					web3[currentlySelectedWeb3ProviderIndex].eth.sendSignedTransaction(signed.rawTransaction)
					.on('receipt', () => {
						console.log("Tokens claimed.");
					}).on('error', (e) => {
						console.log("claimTokens tx fail", e);
					});
				}).catch(e => {
					console.log("claimTokens tx fail", e);
				});
			}
		});
	}

	async function claimPoolTokens(){
		let currentRound = await nftRewardsContract.methods.currentRound().call();
		currentRound = parseFloat(currentRound.toString());

		if(currentRound === 0) return;

		const fromRound = currentRound < 101 ? 0 : currentRound-101;
		const toRound =  currentRound - 1;

		nftRewardsContract.methods.claimPoolTokens(fromRound, toRound).estimateGas({from: process.env.PUBLIC_KEY}, (error, result) => {
			if(!error){
				const tx = {
					from: process.env.PUBLIC_KEY,
					to : nftRewardsContract.options.address,
					data : nftRewardsContract.methods.claimPoolTokens(fromRound, toRound).encodeABI(),
					maxPriorityFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(maxPriorityFeePerGas*1e9),
					maxFeePerGas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex(MAX_GAS_PRICE_GWEI*1e9),
					gas: web3[currentlySelectedWeb3ProviderIndex].utils.toHex("3000000")
				};

				web3[currentlySelectedWeb3ProviderIndex].eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY).then(signed => {
					web3[currentlySelectedWeb3ProviderIndex].eth.sendSignedTransaction(signed.rawTransaction)
					.on('receipt', () => {
						console.log("Pool Tokens claimed.");
					}).on('error', (e) => {
						console.log("claimPoolTokens tx fail", e);
					});
				}).catch(e => {
					console.log("claimPoolTokens tx fail", e);
				});
			}
		});
	}

	setInterval(async () => {
		await claimTokens();
		claimPoolTokens();
	}, AUTO_HARVEST_SEC*1000);
}

// -------------------------------------------------
// 14. CREATE SERVER (USEFUL FOR CLOUD PLATFORMS)
// -------------------------------------------------

const port = process.env.PORT || 4002;
server.listen(port, () => console.log(`Listening on port ${port}`));