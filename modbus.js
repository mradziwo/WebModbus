let port = null;
let reader = null;
let pollingActive = false;
let transactionId = 0; // Sequential transaction counter
const BAUD_RATE = 9600;
const CHAR_TIME_MS = (10 / BAUD_RATE) * 1000;
const RESPONSE_TIMEOUT = 1000;

// DOM Elements
const connectButton = document.getElementById('connectButton');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusEl = document.getElementById('status');
const debugWindow = document.getElementById('debugWindow');

document.addEventListener('DOMContentLoaded', () => {
    initializeRegisterRows();
    setupEventListeners();
});

function initializeRegisterRows() {
    const template = document.getElementById('rowTemplate');
    const container = document.getElementById('registerRows');
    for (let i = 0; i < 10; i++) {
        const clone = document.importNode(template.content, true);
        container.appendChild(clone);
    }
    window.rows = Array.from(container.querySelectorAll('.config-row'));
}

function setupEventListeners() {
    connectButton.addEventListener('click', handleConnect);
    startButton.addEventListener('click', startPolling);
    stopButton.addEventListener('click', stopPolling);
}

async function handleConnect() {
    if (!port) {
        try {
            port = await navigator.serial.requestPort();
            await port.open({
                baudRate: BAUD_RATE,
                dataBits: 8,
                stopBits: 1,
                parity: 'none'
            });
            updateUIState('connected');
        } catch (error) {
            handleError(`Connection error: ${error.message}`);
        }
    } else {
        await safeDisconnect();
    }
}

async function startPolling() {
    if (!validateSlaveAddress()) return;
    pollingActive = true;
    updateUIState('polling');
    
    while (pollingActive) {
        const slave = parseInt(document.getElementById('slaveAddress').value);
        for (const row of window.rows) {
            if (!pollingActive) break;
            const regInput = row.querySelector('.regAddress');
            const reg = parseInt(regInput.value);
            if (isNaN(reg)) continue;
