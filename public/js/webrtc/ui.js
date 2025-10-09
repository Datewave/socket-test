let callTimer = null;
let callStartTime = 0;

export function showStatus(message, isError) {
    const statusDiv = document.getElementById('loginStatus');
    statusDiv.textContent = message;
    statusDiv.className = `status ${isError ? 'error' : 'success'}`;
}

export function updateCallStatus(status) {
    document.getElementById('callStatus').textContent = status;
}

export function showCallControls(state) {
    const startBtn = document.getElementById('startCallBtn');
    const acceptBtn = document.getElementById('acceptCallBtn');
    const rejectBtn = document.getElementById('rejectCallBtn');
    const endBtn = document.getElementById('endCallBtn');

    startBtn.classList.add('hidden');
    acceptBtn.classList.add('hidden');
    rejectBtn.classList.add('hidden');
    endBtn.classList.add('hidden');

    switch (state) {
        case 'idle':
            startBtn.classList.remove('hidden');
            break;
        case 'incoming':
            acceptBtn.classList.remove('hidden');
            rejectBtn.classList.remove('hidden');
            break;
        case 'calling':
        case 'connected':
            endBtn.classList.remove('hidden');
            break;
    }
}

export function startCallTimer() {
    callStartTime = Date.now();
    stopCallTimer();
    callTimer = setInterval(() => {
        const duration = Math.floor((Date.now() - callStartTime) / 1000);
        updateCallDuration(duration);
    }, 1000);
}

export function stopCallTimer() {
    if (callTimer) {
        clearInterval(callTimer);
        callTimer = null;
    }
}

export function updateCallDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    document.getElementById('callDuration').textContent = 
        `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

export function updateCallCost(cost) {
    document.getElementById('callCost').textContent = cost.toFixed(2);
}

export function toggleMute(localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    document.querySelector('button[onclick="toggleMute()"]').textContent = 
        audioTrack.enabled ? 'Mute' : 'Unmute';
}

export function toggleVideo(localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    document.querySelector('button[onclick="toggleVideo()"]').textContent = 
        videoTrack.enabled ? 'Video' : 'No Video';
}

export function resetUI() {
    document.getElementById('callDuration').textContent = '00:00';
    document.getElementById('callCost').textContent = '0';
    showCallControls('idle');
    updateCallStatus('');
}
