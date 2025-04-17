// modbus.js - Complete Implementation
let port = null;
let reader = null;
let isProcessing = false;
let pollingActive = false;
const transactionQueue = [];
const pendingTransactions = new Map();
const BAUD_RATE = 9600;
const CHAR_TIME_MS = (10 / BAUD_RATE) * 1000; // 10 bits per character
const RESPONSE_TIMEOUT = 1000; // 1 second

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
    
    // Create 10 register rows
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
            setupReader();
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
    populateQueue();
    processQueue();
}

function stopPolling() {
    pollingActive = false;
    transactionQueue.length = 0;
    pendingTransactions.clear();
    updateUIState('stopped');
}

async function processQueue() {
    if (isProcessing || !pollingActive) return;
    isProcessing = true;

    while (pollingActive && transactionQueue.length > 0) {
        const transaction = transactionQueue.shift();
        await handleTransaction(transaction);
    }

    if (pollingActive) {
        setTimeout(() => {
            populateQueue();
            processQueue();
        }, 1000);
    }

    isProcessing = false;
}

async function handleTransaction({ slave, reg }) {
    return new Promise(async (resolve) => {
        const frame = createModbusFrame(slave, reg);
        const transactionId = Symbol();

        try {
            // Send request with RS485 timing
            await sendFrame(frame);
            logTransaction('SENT', frame);

            // Set response timeout
            const timeoutId = setTimeout(() => {
                pendingTransactions.delete(transactionId);
                logTransaction('TIMEOUT', frame, `Register ${reg}`);
                resolve();
            }, RESPONSE_TIMEOUT);

            pendingTransactions.set(transactionId, {
                reg,
                timeoutId,
                resolve
            });
        } catch (error) {
            handleError(`Transaction error: ${error.message}`);
            resolve();
        }
    });
}

async function sendFrame(frame) {
    const writer = port.writable.getWriter();
    try {
        await writer.write(frame);
        // RS485 turnaround delay
        await new Promise(resolve => 
            setTimeout(resolve, 3.5 * CHAR_TIME_MS)
        );
    } finally {
        writer.releaseLock();
    }
}

async function setupReader() {
    try {
        reader = port.readable.getReader();
        let buffer = new Uint8Array(0);

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer = concatUint8Arrays(buffer, value);
            
            while (true) {
                const frameInfo = extractFrame(buffer);
                if (!frameInfo) break;
                
                buffer = frameInfo.remaining;
                processResponse(frameInfo.frame);
            }
        }
    } catch (error) {
        if (pollingActive) handleError(`Read error: ${error.message}`);
    } finally {
        reader.releaseLock();
    }
}

function extractFrame(buffer) {
    // Minimum frame size: 1b address + 1b function + 2b CRC = 4 bytes
    if (buffer.length < 4) return null;

    // Search for valid frames using CRC check
    for (let start = 0; start <= buffer.length - 4; start++) {
        const end = Math.min(start + 256, buffer.length); // Max frame length 256 bytes
        for (let i = start; i < end - 1; i++) {
            const potentialFrame = buffer.slice(start, i + 2);
            if (validateFrame(potentialFrame)) {
                return {
                    frame: potentialFrame,
                    remaining: buffer.slice(i + 2)
                };
            }
        }
    }
    return null;
}

function processResponse(frame) {
    logTransaction('RECEIVED', frame);
    
    // Match to oldest pending transaction
    const [transactionId, transaction] = pendingTransactions.entries().next().value;
    if (!transaction) return;

    clearTimeout(transaction.timeoutId);
    pendingTransactions.delete(transactionId);

    // Parse response (example for function code 0x03)
    const byteCount = frame[2];
    const reg = transaction.reg;
    const rawValue = (frame[3] << 8) | frame[4];
    
    updateRegisterDisplay(reg, rawValue);
    transaction.resolve();
}

function createModbusFrame(slave, reg) {
    const message = new Uint8Array([
        slave, 0x03,         // Function code: Read Holding Registers
        (reg >> 8) & 0xFF,   // Register high byte
        reg & 0xFF,          // Register low byte
        0x00, 0x01           // Quantity: 1 register
    ]);
    const crc = calculateCRC(message);
    return new Uint8Array([...message, ...crc]);
}

function calculateCRC(data) {
    let crc = 0xFFFF;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            crc = crc & 0x0001 ? (crc >> 1) ^ 0xA001 : crc >> 1;
        }
    }
    return new Uint8Array([crc & 0xFF, (crc >> 8) & 0xFF]);
}

function validateFrame(frame) {
    if (frame.length < 4) return false;
    const data = frame.slice(0, -2);
    const crc = frame.slice(-2);
    const calculatedCRC = calculateCRC(data);
    return crc[0] === calculatedCRC[0] && crc[1] === calculatedCRC[1];
}

// UI Management
function updateUIState(state) {
    const states = {
        connected: {
            status: 'Connected',
            connectText: 'Disconnect',
            startDisabled: false,
            stopDisabled: true
        },
        polling: {
            status: 'Polling',
            connectText: 'Disconnect',
            startDisabled: true,
            stopDisabled: false
        },
        stopped: {
            status: 'Stopped',
            connectText: 'Disconnect',
            startDisabled: false,
            stopDisabled: true
        },
        disconnected: {
            status: 'Disconnected',
            connectText: 'Connect',
            startDisabled: true,
            stopDisabled: true
        }
    };

    const { status, connectText, startDisabled, stopDisabled } = states[state];
    statusEl.textContent = `Status: ${status}`;
    connectButton.textContent = connectText;
    startButton.disabled = startDisabled;
    stopButton.disabled = stopDisabled;
}

function populateQueue() {
    const slave = parseInt(document.getElementById('slaveAddress').value);
    rows.forEach(row => {
        const regInput = row.querySelector('.regAddress');
        const reg = parseInt(regInput.value);
        if (!isNaN(reg)) transactionQueue.push({ slave, reg });
    });
}

function updateRegisterDisplay(reg, rawValue) {
    const row = rows.find(r => 
        parseInt(r.querySelector('.regAddress').value) === reg
    );
    if (!row) return;

    const isSigned = row.querySelector('.signedCheck').checked;
    const value = isSigned && rawValue > 32767 ? 
        rawValue - 65536 : rawValue;
    row.querySelector('.valueDisplay').textContent = value;
}

async function safeDisconnect() {
    pollingActive = false;
    try {
        await reader?.cancel();
        await port?.close();
    } catch (error) {
        console.error('Disconnect error:', error);
    }
    port = reader = null;
    updateUIState('disconnected');
}

// Utilities
function concatUint8Arrays(a, b) {
    const result = new Uint8Array(a.length + b.length);
    result.set(a);
    result.set(b, a.length);
    return result;
}

function validateSlaveAddress() {
    const slave = parseInt(document.getElementById('slaveAddress').value);
    if (isNaN(slave) || slave < 1 || slave > 247) {
        handleError('Invalid slave address (1-247)');
        return false;
    }
    return true;
}

function logTransaction(direction, data, message = '') {
    const timestamp = new Date().toISOString();
    const hexString = Array.from(data)
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');

    const entry = document.createElement('div');
    entry.style.color = {
        SENT: '#0000CC',
        RECEIVED: '#009900',
        TIMEOUT: '#CC0000'
    }[direction] || '#000000';

    entry.innerHTML = `
        <span class="timestamp">${timestamp}</span>
        <span class="direction">${direction.padEnd(9)}</span>
        <span class="data">${hexString}</span>
        <span class="message">${message}</span>
    `;
    
    debugWindow.appendChild(entry);
    debugWindow.scrollTop = debugWindow.scrollHeight;
}

function handleError(message) {
    const timestamp = new Date().toISOString();
    const entry = document.createElement('div');
    entry.style.color = '#CC0000';
    entry.innerHTML = `
        <span class="timestamp">${timestamp}</span>
        <span class="error">ERROR:</span>
        <span class="message">${message}</span>
    `;
    debugWindow.appendChild(entry);
    debugWindow.scrollTop = debugWindow.scrollHeight;
}

// Style for debug window (add to CSS)
const debugStyle = document.createElement('style');
debugStyle.textContent = `
    .timestamp { color: #666; margin-right: 10px; }
    .direction { font-weight: bold; margin-right: 10px; min-width: 80px; display: inline-block; }
    .data { font-family: monospace; margin-right: 15px; }
    .error { font-weight: bold; margin-right: 5px; }
`;
document.head.appendChild(debugStyle);
