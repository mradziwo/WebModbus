let port = null;
let reader = null;
let pollingActive = false;
let transactionId = 0; // Sequential transaction counter

const BAUD_RATE = 9600;
const CHAR_TIME_MS = (10 / BAUD_RATE) * 1000;
const RESPONSE_TIMEOUT = 1000;

// Recording-related variables
let isRecording = false;
let recordedData = [];
let recordButton = null;

const connectButton = document.getElementById('connectButton');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusEl = document.getElementById('status');
const debugWindow = document.getElementById('debugWindow');

document.addEventListener('DOMContentLoaded', () => {
    initializeRegisterRows();
    setupEventListeners();
    recordButton = document.getElementById('recordButton');
    if (!recordButton) {
        // Create the record button if not present
        const btn = document.createElement('button');
        btn.id = 'recordButton';
        btn.disabled = true;
        btn.textContent = 'Start Recording';
        stopButton.parentNode.insertBefore(btn, stopButton.nextSibling);
        recordButton = btn;
    }
    recordButton.addEventListener('click', toggleRecording);
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
        const cycleTimestamp = new Date().toISOString();
        const slave = parseInt(document.getElementById('slaveAddress').value);
        let cycleValues = [];
        for (const row of window.rows) {
            if (!pollingActive) break;
            const regInput = row.querySelector('.regAddress');
            const reg = parseInt(regInput.value);
            if (isNaN(reg)) {
                cycleValues.push('');
                continue;
            }
            transactionId++;
            await handleTransaction(slave, reg, row, transactionId);
            // After transaction, get the latest value from the display
            const val = row.querySelector('.valueDisplay').textContent;
            cycleValues.push(val !== '-' ? val : '');
        }
        // After all registers in this cycle, record if recording is active
        if (isRecording) {
            recordedData.push([cycleTimestamp, ...cycleValues]);
        }
        if (pollingActive) await sleep(1000);
    }
}

function stopPolling() {
    pollingActive = false;
    if (isRecording) {
        downloadRecordedData();
        isRecording = false;
        recordButton.textContent = 'Start Recording';
        recordedData = [];
    }
    updateUIState('stopped');
}

async function handleTransaction(slave, reg, row, tid) {
    const frame = createModbusFrame(slave, reg);
    try {
        await sendFrame(frame, tid);
        const response = await waitForResponse(tid);
        if (response) {
            processValidResponse(response, tid, reg, row);
        } else {
            logTransaction('TIMEOUT', frame, tid, `No response`);
        }
    } catch (error) {
        handleError(`Transaction ${tid} failed: ${error.message}`, tid);
    }
}

async function sendFrame(frame, tid) {
    const writer = port.writable.getWriter();
    try {
        await writer.write(frame);
        logTransaction('SENT', frame, tid);
        await sleep(3.5 * CHAR_TIME_MS);
    } finally {
        writer.releaseLock();
    }
}

async function waitForResponse(tid) {
    let buffer = new Uint8Array(0);
    const startTime = Date.now();
    let gotFrame = null;
    let reader;
    try {
        reader = port.readable.getReader();
        while (Date.now() - startTime < RESPONSE_TIMEOUT) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            buffer = concatUint8Arrays(buffer, value);
            while (buffer.length >= 7) {
                const frameInfo = extractFrame(buffer);
                if (!frameInfo) break;
                buffer = frameInfo.remaining;
                if (validateFrame(frameInfo.frame)) {
                    logTransaction('RECEIVED', frameInfo.frame, tid);
                    gotFrame = frameInfo.frame;
                    break;
                } else {
                    logTransaction('INVALID', frameInfo.frame, tid, "CRC mismatch");
                }
            }
            if (gotFrame) break;
        }
    } catch (error) {
        logTransaction('ERROR', null, tid, error.message);
    } finally {
        try { reader && reader.releaseLock(); } catch (e) {}
    }
    return gotFrame;
}

function processValidResponse(frame, tid, reg, row) {
    const byteCount = frame[2];
    if (byteCount !== 2) {
        logTransaction('INVALID', frame, tid, "Bad byte count");
        return;
    }
    const rawValue = (frame[3] << 8) | frame[4];
    const isSigned = row.querySelector('.signedCheck').checked;
    const value = isSigned && rawValue > 32767 ? rawValue - 65536 : rawValue;
    row.querySelector('.valueDisplay').textContent = value;
}

function createModbusFrame(slave, reg) {
    const message = new Uint8Array([
        slave, 0x03,
        (reg >> 8) & 0xFF,
        reg & 0xFF,
        0x00, 0x01
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

function extractFrame(buffer) {
    for (let i = 0; i <= buffer.length - 7; i++) {
        const candidate = buffer.slice(i, i + 7);
        if (validateFrame(candidate)) {
            return {
                frame: candidate,
                remaining: buffer.slice(i + 7)
            };
        }
    }
    return null;
}

function validateFrame(frame) {
    if (frame.length < 7) return false;
    const data = frame.slice(0, -2);
    const crc = frame.slice(-2);
    const calculatedCRC = calculateCRC(data);
    return crc[0] === calculatedCRC[0] && crc[1] === calculatedCRC[1];
}

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

async function safeDisconnect() {
    pollingActive = false;
    try {
        await reader?.cancel();
        await port?.close();
    } catch (error) {
        // Ignore
    }
    port = reader = null;
    updateUIState('disconnected');
}

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

    // Enable/disable record button
    if (recordButton) {
        if (state === 'polling') {
            recordButton.disabled = false;
        } else {
            recordButton.disabled = true;
            if (isRecording) {
                isRecording = false;
                recordedData = [];
                recordButton.textContent = 'Start Recording';
            }
        }
    }
}

function logTransaction(direction, data, tid, message = '') {
    const timestamp = new Date().toISOString();
    let hexString = '';
    if (data && typeof data.length === 'number') {
        hexString = Array.from(data)
            .map(b => b.toString(16).padStart(2, '0').toUpperCase())
            .join(' ');
    }
    const entry = document.createElement('div');
    entry.style.color = {
        SENT: '#0000CC',
        RECEIVED: '#009900',
        TIMEOUT: '#CC0000',
        INVALID: '#FF9900',
        ERROR: '#FF00FF',
        RECORD: '#0066CC'
    }[direction] || '#000000';

    entry.innerHTML = `
        <span class="timestamp">${timestamp}</span>
        <span class="tid" style="color:#666; font-family:monospace; margin-right:10px;">${tid ? `[TID:${tid.toString().padStart(4, '0')}]` : ''}</span>
        <span class="direction">${direction.padEnd(9)}</span>
        <span class="data">${hexString}</span>
        <span class="message">${message}</span>
    `;
    debugWindow.appendChild(entry);
    debugWindow.scrollTop = debugWindow.scrollHeight;
}

function handleError(message, tid = '') {
    const timestamp = new Date().toISOString();
    const entry = document.createElement('div');
    entry.style.color = '#CC0000';
    entry.innerHTML = `
        <span class="timestamp">${timestamp}</span>
        <span class="tid" style="color:#666; font-family:monospace; margin-right:10px;">${tid ? `[TID:${tid.toString().padStart(4, '0')}]` : ''}</span>
        <span class="error">ERROR:</span>
        <span class="message">${message}</span>
    `;
    debugWindow.appendChild(entry);
    debugWindow.scrollTop = debugWindow.scrollHeight;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Recording-related functions
function toggleRecording() {
    if (!isRecording) {
        isRecording = true;
        recordedData = [];
        recordButton.textContent = 'Stop Recording & Save';
        logTransaction('RECORD', null, null, 'Recording started');
    } else {
        isRecording = false;
        downloadRecordedData();
        recordedData = [];
        recordButton.textContent = 'Start Recording';
    }
}

function downloadRecordedData() {
    if (recordedData.length === 0) {
        handleError('No recorded data to download');
        return;
    }
    // Header: Timestamp, Register_1, Register_2, ...
    const headers = ['Timestamp', ...window.rows.map((row, i) =>
        `Register_${row.querySelector('.regAddress').value || (i + 1)}`)];
    const csvContent = [
        headers.join(','),
        ...recordedData.map(row => row.join(','))
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `modbus_recording_${new Date().toISOString().slice(0,16)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    logTransaction('RECORD', null, null, `Saved ${recordedData.length} records`);
}

// Add debug window CSS for clarity
const debugStyle = document.createElement('style');
debugStyle.textContent = `
    .timestamp { color: #666; margin-right: 10px; }
    .direction { font-weight: bold; margin-right: 10px; min-width: 80px; display: inline-block; }
    .data { font-family: monospace; margin-right: 15px; }
    .error { font-weight: bold; margin-right: 5px; }
`;
document.head.appendChild(debugStyle);
