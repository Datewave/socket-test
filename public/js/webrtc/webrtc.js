// Import configurations first
import { peerConfig, API_BASE_URL } from './config.js';

// Import utilities and services
import { showStatus, updateCallStatus, showCallControls, startCallTimer } from './ui.js';
import { getUserInfo } from './auth.js';
import { socket, emitCallStart } from './socket.js';

let peerConnection = null;
let localStream = null;
let currentCall = null;
let iceCandidateBuffer = [];
let iceCandidateCount = 0;

export function getCurrentCall() {
    return currentCall;
}

export function setCurrentCall(call) {
    currentCall = call;
}

export function getPeerConnection() {
    return peerConnection;
}

export async function ensurePeerConnection() {
    if (!peerConnection) {
        console.log('🔧 No peer connection found, creating new one...');
        await createPeerConnection();
    }
    return peerConnection;
}

export async function initializeMedia() {
    try {
        // Request notification permission
        if ('Notification' in window && Notification.permission === 'default') {
            await Notification.requestPermission();
        }

        console.log('🔵 AUDIO DEBUG: Starting media initialization...');
        
        // Check available devices first
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        const videoInputs = devices.filter(device => device.kind === 'videoinput');
        console.log('🔵 Available devices:', {
            audioInputs: audioInputs.length,
            videoInputs: videoInputs.length,
            audioDevices: audioInputs.map(d => ({ label: d.label, deviceId: d.deviceId }))
        });

        // First try to get both video and audio
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000
                }
            });
            console.log('✅ Got both video and audio streams');
        } catch (e) {
            console.warn('Failed to get both video and audio, trying audio only:', e);
            // If that fails, try audio only
            localStream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000
                }
            });
            showStatus('Video unavailable - audio only mode', true);
            console.log('✅ Got audio-only stream');
        }
        
        // 🔵 AUDIO DEBUG: Detailed stream analysis
        console.log('🔵 AUDIO DEBUG: Local stream details:');
        const audioTracks = localStream.getAudioTracks();
        const videoTracks = localStream.getVideoTracks();
        
        console.log('🎤 Audio tracks:', audioTracks.length);
        audioTracks.forEach((track, index) => {
            console.log(`🎤 Audio track ${index}:`, {
                label: track.label,
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
                kind: track.kind,
                settings: track.getSettings(),
                constraints: track.getConstraints()
            });
            
            // Test audio level
            testAudioLevel(track);
        });
        
        console.log('📹 Video tracks:', videoTracks.length);
        videoTracks.forEach((track, index) => {
            console.log(`📹 Video track ${index}:`, {
                label: track.label,
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
                kind: track.kind
            });
        });
        
        document.getElementById('localVideo').srcObject = localStream;
        
        console.log('✅ Media initialized successfully:', 
            'Audio tracks:', localStream.getAudioTracks().length,
            'Video tracks:', localStream.getVideoTracks().length
        );
        return localStream;
    } catch (error) {
        console.error('❌ Error accessing media devices:', error);
        console.error('❌ Error details:', {
            name: error.name,
            message: error.message,
            constraint: error.constraint
        });
        showStatus('Error accessing camera/microphone. Please check your device permissions.', true);
        throw error;
    }
}

export async function createPeerConnection() {
    // Clean up existing connection
    if (peerConnection) {
        console.log('🔄 Closing existing peer connection, state:', peerConnection.connectionState);
        peerConnection.close();
        peerConnection = null;
    }
    
    console.log('🔧 Creating new peer connection with config:', peerConfig);
    peerConnection = new RTCPeerConnection(peerConfig);
    
    // Add debugging for connection state changes
    peerConnection.addEventListener('connectionstatechange', () => {
        console.log('🔗 Peer connection state changed to:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
            console.warn('⚠️ Peer connection failed or closed unexpectedly');
        }
    });

    // Add local stream if available
    if (localStream) {
        console.log('🔵 AUDIO DEBUG: Adding local tracks to peer connection...');
        const tracks = localStream.getTracks();
        
        if (tracks.length === 0) {
            console.error('❌ CRITICAL: Local stream has NO tracks!');
            console.log('🔄 Attempting to reinitialize media...');
            try {
                await initializeMedia();
                const newTracks = localStream.getTracks();
                console.log(`✅ Reinitialized media, now have ${newTracks.length} tracks`);
            } catch (error) {
                console.error('❌ Failed to reinitialize media:', error);
            }
        }
        
        localStream.getTracks().forEach((track, index) => {
            console.log(`🎤 Adding local track ${index}:`, {
                kind: track.kind,
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
                label: track.label
            });
            
            // CRITICAL FIX: Ensure track is enabled before adding
            if (track.readyState === 'ended') {
                console.error(`❌ Track ${index} is ENDED! Cannot add to peer connection`);
                return;
            }
            
            track.enabled = true; // Force enable
            const sender = peerConnection.addTrack(track, localStream);
            console.log('📤 Track sender created:', sender);
        });
        console.log('✅ Added local stream to peer connection');
        
        // Verify senders were added
        const senders = peerConnection.getSenders();
        console.log('🔵 AUDIO DEBUG: Total senders after adding tracks:', senders.length);
        senders.forEach((sender, index) => {
            if (sender.track) {
                console.log(`📤 Sender ${index}:`, {
                    kind: sender.track.kind,
                    enabled: sender.track.enabled,
                    readyState: sender.track.readyState
                });
            } else {
                console.warn(`⚠️ Sender ${index} has NO track!`);
            }
        });
        
        if (senders.length === 0) {
            console.error('❌ CRITICAL: No senders were added to peer connection!');
        }
    } else {
        console.warn('⚠️ No local stream available when creating peer connection');
    }

    // Handle incoming stream
    peerConnection.ontrack = (event) => {
        console.log('🔵 AUDIO DEBUG: ========== REMOTE TRACK RECEIVED ==========');
        console.log('🎵 Received remote track:', {
            kind: event.track.kind,
            enabled: event.track.enabled,
            muted: event.track.muted,
            readyState: event.track.readyState,
            label: event.track.label,
            id: event.track.id
        });
        
        const remoteVideo = document.getElementById('remoteVideo');
        const remoteStream = event.streams[0];
        
        // 🔵 AUDIO DEBUG: Detailed stream analysis
        console.log('🔵 AUDIO DEBUG: Remote stream details:');
        console.log('📺 Stream ID:', remoteStream.id);
        console.log('📺 Stream active:', remoteStream.active);
        
        const audioTracks = remoteStream.getAudioTracks();
        const videoTracks = remoteStream.getVideoTracks();
        
        console.log('🔊 Remote audio tracks:', audioTracks.length);
        audioTracks.forEach((track, index) => {
            console.log(`🔊 Remote audio track ${index}:`, {
                id: track.id,
                label: track.label,
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
                kind: track.kind,
                settings: track.getSettings()
            });
            
            // Monitor track state changes
            track.addEventListener('ended', () => {
                console.log('❌ Remote audio track ended:', track.id);
            });
            
            track.addEventListener('mute', () => {
                console.log('🔇 Remote audio track muted:', track.id);
            });
            
            track.addEventListener('unmute', () => {
                console.log('🔊 Remote audio track unmuted:', track.id);
            });
        });
        
        console.log('📹 Remote video tracks:', videoTracks.length);
        videoTracks.forEach((track, index) => {
            console.log(`📹 Remote video track ${index}:`, {
                id: track.id,
                label: track.label,
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
                kind: track.kind
            });
        });
        
        // Set the stream to the video element
        remoteVideo.srcObject = remoteStream;
        
        // 🔵 AUDIO DEBUG: Ensure audio plays by explicitly setting properties
        console.log('🔵 AUDIO DEBUG: Setting up remote video element for audio playback...');
        remoteVideo.muted = false;
        remoteVideo.volume = 1.0;
        remoteVideo.autoplay = true;
        remoteVideo.playsInline = true;
        
        console.log('🔵 AUDIO DEBUG: Remote video element properties:', {
            muted: remoteVideo.muted,
            volume: remoteVideo.volume,
            autoplay: remoteVideo.autoplay,
            playsInline: remoteVideo.playsInline,
            hasAudio: audioTracks.length > 0
        });
        
        // Try to play the remote stream
        remoteVideo.play().then(() => {
            console.log('✅ Remote stream playing successfully');
            console.log('🔵 AUDIO DEBUG: Video element playing state:', {
                paused: remoteVideo.paused,
                currentTime: remoteVideo.currentTime,
                duration: remoteVideo.duration,
                volume: remoteVideo.volume,
                muted: remoteVideo.muted
            });
            
            // Test audio level on remote tracks
            audioTracks.forEach((track, index) => {
                testAudioLevel(track, `Remote Audio Track ${index}`);
            });
            
        }).catch(error => {
            console.error('❌ Remote stream autoplay failed:', error);
            console.error('❌ Error details:', {
                name: error.name,
                message: error.message
            });
            showStatus('Click the remote video to enable audio', true);
            
            // Add click handler to enable audio
            remoteVideo.addEventListener('click', () => {
                remoteVideo.play().then(() => {
                    console.log('✅ Remote stream playing after user interaction');
                }).catch(e => {
                    console.error('❌ Still failed to play after click:', e);
                });
            }, { once: true });
        });
        
        console.log('🔵 AUDIO DEBUG: ========== END REMOTE TRACK SETUP ==========');
    };

    // Track ICE gathering progress
    peerConnection.onicegatheringstatechange = () => {
        if (peerConnection.iceGatheringState === 'complete') {
            console.log(`✅ ICE gathering completed. Total candidates: ${iceCandidateCount}`);
        }
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate && currentCall) {
            iceCandidateCount++;
            const candidate = event.candidate;
            
            // 🔵 AUDIO DEBUG: Log detailed ICE candidate info
            console.log('🔵 ICE Candidate:', candidate.candidate);
            console.log('🔵 Candidate Type:', candidate.type, 'Protocol:', candidate.protocol);
            if (candidate.type === 'relay') {
                console.log('✅ TURN server is working! (relay candidate found)');
            }
            
            const { role: userRole, id: userId } = getUserInfo();
            const targetUserId = userRole === 'USER' ? currentCall.staffUserId : currentCall.userId;
            
            // Always buffer the candidate first
            bufferIceCandidate(candidate, targetUserId);
            
            // Enhanced candidate selection and prioritization
            const priority = 
                candidate.type === 'relay' ? 'high' :
                candidate.type === 'srflx' ? 'medium' : 'low';

            // Try to send the candidate
            sendIceCandidate(candidate, targetUserId, priority);
        } else if (!event.candidate) {
            console.log(`✅ Finished collecting ICE candidates. Total: ${iceCandidateCount}`);
            // 🔵 AUDIO DEBUG: Start stats monitoring after ICE gathering
            startStatsMonitoring();
        }
    };

    // Enhanced ICE connection state monitoring
    peerConnection.oniceconnectionstatechange = () => {
        console.log('🔄 ICE connection state changed:', peerConnection.iceConnectionState);
        const states = {
            iceConnectionState: peerConnection.iceConnectionState,
            signalingState: peerConnection.signalingState,
            connectionState: peerConnection.connectionState,
            iceGatheringState: peerConnection.iceGatheringState
        };
        console.log('📊 Current states:', states);

        switch (peerConnection.iceConnectionState) {
            case 'connected':
                console.log('✅ ICE connection established!');
                updateCallStatus('Connected');
                showStatus('Call connected successfully', false);
                if (currentCall && currentCall.status !== 'CONNECTED') {
                    emitCallStart(currentCall.id, states);
                }
                break;
            case 'failed':
                console.error('❌ ICE connection failed');
                showStatus('Connection failed. Please try again.', true);
                endCall();
                break;
        }
    };

    return peerConnection;
}

export async function handleOffer(data) {
    try {
        console.log('📥 Received offer:', data);
        if (!currentCall) {
            console.error('❌ No current call when receiving offer');
            return;
        }

        // Debug call object and IDs
        console.log('🔍 Debug - Current call object:', {
            callId: currentCall.id,
            userId: currentCall.userId,
            staffUserId: currentCall.staffUserId,
            caller: currentCall.caller
        });

        // Convert all IDs to strings for comparison
        const { role: userRole } = getUserInfo();
        const incomingUserId = String(data.from);
        const callUserId = currentCall.userId ? String(currentCall.userId) : null;
        const staffUserId = currentCall.staffUserId ? String(currentCall.staffUserId) : null;

        // Verify the offer is from the expected caller/staff
        if (userRole === 'USER' && incomingUserId !== staffUserId) {
            console.error('❌ Offer received from unexpected staff');
            return;
        } else if (userRole === 'STAFF' && incomingUserId !== String(currentCall.userId)) {
            console.error('❌ Offer received from unexpected user');
            return;
        }

        // Ensure we have media streams before proceeding
        if (!localStream) {
            console.log('🎥 Initializing media before handling offer...');
            await initializeMedia();
        }

        // Create or recreate peer connection
        await createPeerConnection();
        
        // Validate offer before processing
        if (!data.offer || !data.offer.type || data.offer.type !== 'offer') {
            console.error('❌ Invalid offer received:', data.offer);
            showStatus('Invalid call offer received', true);
            return;
        }

        console.log('📝 Setting remote description (offer)');
        console.log('🔍 Peer connection state before setting remote description:', {
            signalingState: peerConnection.signalingState,
            iceConnectionState: peerConnection.iceConnectionState
        });
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        console.log('✅ Remote description set successfully');
        
        // Verify we're in the correct state to create an answer
        if (peerConnection.signalingState !== 'have-remote-offer') {
            console.error('❌ Unexpected signaling state after setting remote description:', peerConnection.signalingState);
            showStatus('Connection setup failed - invalid state', true);
            return;
        }
        
        // Wait a bit for the remote description to be fully processed
        await new Promise(resolve => setTimeout(resolve, 500));
        
        console.log('📝 Creating answer');
        const answer = await peerConnection.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        
        console.log('📝 Setting local description (answer)');
        await peerConnection.setLocalDescription(answer);
        
        // 🔵 AUDIO DEBUG: Detailed SDP analysis
        console.log('🔵 AUDIO DEBUG: ========== SDP ANALYSIS (ANSWER) ==========');
        console.log('🔍 Answer SDP contains audio:', answer.sdp.includes('m=audio'));
        console.log('🔍 Answer SDP contains video:', answer.sdp.includes('m=video'));
        
        // Extract audio codec information
        const audioLines = answer.sdp.split('\n').filter(line => 
            line.includes('m=audio') || 
            line.includes('a=rtpmap') && line.includes('audio') ||
            line.includes('opus') || 
            line.includes('PCMU') || 
            line.includes('PCMA')
        );
        console.log('🎵 Audio SDP lines:', audioLines);
        
        if (answer.sdp.includes('m=audio')) {
            console.log('✅ Audio media line found in answer');
            
            // Check for common audio codecs
            if (answer.sdp.includes('opus')) {
                console.log('🎵 Opus codec found in SDP');
            }
            if (answer.sdp.includes('PCMU') || answer.sdp.includes('PCMA')) {
                console.log('🎵 PCM codec found in SDP');
            }
        } else {
            console.error('❌ No audio media line in answer SDP!');
        }
        
        // Log full SDP for debugging (truncated)
        console.log('📋 Answer SDP (first 500 chars):', answer.sdp.substring(0, 500));
        console.log('🔵 AUDIO DEBUG: ========== END SDP ANALYSIS ==========');
        
        // Wait for ICE gathering to complete or timeout after 5 seconds
        console.log('⏳ Waiting for ICE gathering...');
        const iceGatheringPromise = new Promise(resolve => {
            if (peerConnection.iceGatheringState === 'complete') {
                resolve();
                return;
            }
            
            const timeout = setTimeout(() => {
                console.log('⏰ ICE gathering timeout, proceeding anyway');
                resolve();
            }, 5000);
            
            const checkState = () => {
                if (peerConnection.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    console.log('✅ ICE gathering completed');
                    resolve();
                } else {
                    setTimeout(checkState, 100);
                }
            };
            checkState();
        });
        
        await iceGatheringPromise;
        
        socket.emit('answer', {
            callId: currentCall.id,
            targetUserId: data.from,
            answer: peerConnection.localDescription
        });
        
        updateCallStatus('Answer sent, establishing connection...');
        showStatus('Connecting to call...', false);
        
    } catch (error) {
        console.error('Handle offer error:', error);
        showStatus('Failed to establish connection: ' + error.message, true);
        
        // Clean up on error
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        
        // Try to recover by recreating peer connection
        try {
            console.log('🔄 Attempting to recover...');
            await createPeerConnection();
        } catch (recoveryError) {
            console.error('Failed to recover peer connection:', recoveryError);
        }
    }
}

export async function handleAnswer(data) {
    try {
        console.log('📥 Received answer from:', data.fromName);
        
        // Ensure we have a peer connection
        const pc = await ensurePeerConnection();
        if (!pc) {
            console.error('❌ Failed to ensure peer connection exists');
            showStatus('Connection error - please try calling again', true);
            return;
        }

        if (peerConnection.signalingState === 'stable') {
            console.log('⚠️ Signaling state already stable, ignoring answer');
            return;
        }

        console.log('📝 Setting remote description (answer)');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        console.log('✅ Answer processed successfully');
        
    } catch (error) {
        console.error('❌ Handle answer error:', error);
        showStatus('Failed to process answer: ' + error.message, true);
    }
}

export async function handleIceCandidate(data) {
    try {
        console.log('Received ICE candidate:', data);
        if (!peerConnection) {
            console.error('No peer connection when receiving ICE candidate');
            return;
        }

        if (peerConnection.remoteDescription === null) {
            console.warn('Received ICE candidate before remote description, buffering...');
            setTimeout(async () => {
                if (peerConnection.remoteDescription) {
                    console.log('Adding buffered ICE candidate');
                    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
                }
            }, 1000);
            return;
        }

        console.log('Adding ICE candidate');
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        console.log('ICE candidate added successfully');
    } catch (error) {
        console.error('Handle ICE candidate error:', error);
        console.log('Failed candidate:', data.candidate);
    }
}

// Helper function to send ICE candidate with retry
async function sendIceCandidate(candidate, targetUserId, priority) {
    const maxRetries = 3;
    let retryCount = 0;
    
    const attemptSend = async () => {
        try {
            if (!socket.connected) {
                console.log('⚠️ Socket disconnected, attempting to reconnect...');
                socket.connect();
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Check if we still have a current call
            if (!currentCall || !currentCall.id) {
                console.log('No current call, skipping ICE candidate send');
                return false;
            }

            // Send ICE candidate without waiting for acknowledgment to avoid timeouts
            socket.emit('ice-candidate', {
                callId: currentCall.id,
                targetUserId: targetUserId,
                candidate: candidate,
                priority: priority
            });
            
            console.log(`✅ Successfully sent ${priority} priority ICE candidate`);
            return true;
        } catch (error) {
            console.log(`❌ Failed to send ICE candidate (attempt ${retryCount + 1}):`, error);
            if (retryCount < maxRetries) {
                retryCount++;
                await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                return attemptSend();
            }
            return false;
        }
    };
    
    return attemptSend();
}

// Helper function to buffer ICE candidate
function bufferIceCandidate(candidate, targetUserId) {
    iceCandidateBuffer.push({
        candidate,
        targetUserId,
        priority: candidate.type === 'relay' ? 'high' : 
                 candidate.type === 'srflx' ? 'medium' : 'low',
        timestamp: Date.now()
    });
}

export function getLocalStream() {
    return localStream;
}

// Test audio functionality
export function testAudio() {
    console.log('🔍 Testing audio functionality...');
    
    // Test local audio
    if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        console.log('🎤 Local audio tracks:', audioTracks.length);
        audioTracks.forEach((track, index) => {
            console.log(`Local audio track ${index}:`, {
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
                label: track.label
            });
        });
    } else {
        console.warn('⚠️ No local stream available');
    }
    
    // Test peer connection senders
    if (peerConnection) {
        const senders = peerConnection.getSenders();
        console.log('📤 Peer connection senders:', senders.length);
        senders.forEach((sender, index) => {
            if (sender.track) {
                console.log(`Sender ${index}:`, {
                    kind: sender.track.kind,
                    enabled: sender.track.enabled,
                    readyState: sender.track.readyState
                });
            }
        });
        
        const receivers = peerConnection.getReceivers();
        console.log('📥 Peer connection receivers:', receivers.length);
        receivers.forEach((receiver, index) => {
            if (receiver.track) {
                console.log(`Receiver ${index}:`, {
                    kind: receiver.track.kind,
                    enabled: receiver.track.enabled,
                    readyState: receiver.track.readyState
                });
            }
        });
        
        console.log('🔗 Peer connection state:', {
            signalingState: peerConnection.signalingState,
            iceConnectionState: peerConnection.iceConnectionState,
            connectionState: peerConnection.connectionState
        });
    } else {
        console.warn('⚠️ No peer connection available');
    }
    
    // Test remote audio
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo.srcObject) {
        const remoteStream = remoteVideo.srcObject;
        const audioTracks = remoteStream.getAudioTracks();
        console.log('🔊 Remote audio tracks:', audioTracks.length);
        audioTracks.forEach((track, index) => {
            console.log(`Remote audio track ${index}:`, {
                enabled: track.enabled,
                muted: track.muted,
                readyState: track.readyState,
                label: track.label
            });
        });
        
        console.log('📺 Remote video element:', {
            muted: remoteVideo.muted,
            volume: remoteVideo.volume,
            paused: remoteVideo.paused,
            hasAudio: remoteStream.getAudioTracks().length > 0
        });
    } else {
        console.warn('⚠️ No remote stream available');
    }
}

export async function startCall() {
    try {
        // Import the getSelectedStaffId function
        const { getSelectedStaffId } = await import('./socket.js');
        const selectedStaffId = getSelectedStaffId();
        
        if (!selectedStaffId) {
            showStatus('Please select a staff member', true);
            return;
        }

        const { id: userId } = getUserInfo();
        
        // Ensure we have media access before initiating call
        if (!localStream) {
            await initializeMedia();
        }
        
        // Create peer connection
        console.log('🔧 Creating peer connection for outgoing call...');
        await createPeerConnection();
        console.log('✅ Peer connection created, state:', peerConnection?.connectionState);
        
        // Verify local stream is added to peer connection
        const senders = peerConnection.getSenders();
        if (senders.length === 0) {
            console.warn('⚠️ No senders found! Re-adding local stream...');
            if (localStream) {
                localStream.getTracks().forEach(track => {
                    peerConnection.addTrack(track, localStream);
                });
            }
        }
        
        // Create and set local description
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        
        await peerConnection.setLocalDescription(offer);
        
        // 🔵 AUDIO DEBUG: Detailed SDP analysis for offer
        console.log('🔵 AUDIO DEBUG: ========== SDP ANALYSIS (OFFER) ==========');
        console.log('🔍 Offer SDP contains audio:', offer.sdp.includes('m=audio'));
        console.log('🔍 Offer SDP contains video:', offer.sdp.includes('m=video'));
        
        // Extract audio codec information
        const audioLines = offer.sdp.split('\n').filter(line => 
            line.includes('m=audio') || 
            line.includes('a=rtpmap') && line.includes('audio') ||
            line.includes('opus') || 
            line.includes('PCMU') || 
            line.includes('PCMA')
        );
        console.log('🎵 Audio SDP lines:', audioLines);
        
        if (offer.sdp.includes('m=audio')) {
            console.log('✅ Audio media line found in offer');
            
            // Check for common audio codecs
            if (offer.sdp.includes('opus')) {
                console.log('🎵 Opus codec found in SDP');
            }
            if (offer.sdp.includes('PCMU') || offer.sdp.includes('PCMA')) {
                console.log('🎵 PCM codec found in SDP');
            }
        } else {
            console.error('❌ No audio media line in offer SDP!');
        }
        
        // Log full SDP for debugging (truncated)
        console.log('📋 Offer SDP (first 500 chars):', offer.sdp.substring(0, 500));
        console.log('🔵 AUDIO DEBUG: ========== END SDP ANALYSIS ==========');
        
        // First initiate call through REST API
        const response = await fetch(`${API_BASE_URL}/calls/initiate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getUserInfo().token}`
            },
            body: JSON.stringify({
                staffId: selectedStaffId
            })
        });

        const data = await response.json();
        if (!data.success) {
            if (data.staffBusy) {
                showStatus('Staff is currently busy with another call. Please try again later.', true);
                return;
            }
            throw new Error(data.message || 'Failed to initiate call');
        }

        // Store the call details
        setCurrentCall(data.data.call);

        // Join the call room first
        socket.emit('join-call', { callId: data.data.call.id });

        // Now emit the WebRTC offer through socket
        socket.emit('offer', {
            callId: data.data.call.id,
            targetUserId: data.data.call.staffUserId,
            offer: offer
        });
        
        showStatus('Calling staff member...', false);
        updateCallStatus('Calling...');
        showCallControls('calling');
        
    } catch (error) {
        console.error('Start call error:', error);
        showStatus('Failed to start call: ' + error.message, true);
        cleanup();
    }
}

export async function acceptCall() {
    if (!currentCall) {
        showStatus('No incoming call to accept', true);
        return;
    }
    
    console.log('📞 Accepting call:', currentCall.id);
    
    try {
        // Join the call room first (CRITICAL: Staff must join the call room!)
        socket.emit('join-call', { callId: currentCall.id });
        
        // Emit call acceptance
        socket.emit('call-accept', {
            callId: currentCall.id,
            targetUserId: currentCall.userId
        });
        
        // Update call status
        currentCall.status = 'ACCEPTED';
        
        // Now process any pending offer (this should happen AFTER manual acceptance)
        console.log('🔄 Processing pending offer after manual acceptance...');
        
        // Try to process pending offer directly first
        console.log('🔍 Attempting to process pending offer directly...');
        const { processPendingOfferDirectly } = await import('./socket.js');
        const offerProcessed = await processPendingOfferDirectly(currentCall.id);
        
        if (!offerProcessed) {
            // Fallback to socket event
            console.log('📤 Emitting process-pending-offer for call:', currentCall.id);
            console.log('🔍 Socket connected:', socket.connected);
            socket.emit('process-pending-offer', { callId: currentCall.id });
            console.log('📤 process-pending-offer emitted successfully');
        }
        
        // CRITICAL: Ensure we have media access BEFORE accepting call
        if (!localStream) {
            console.log('🎤 Initializing media for call acceptance...');
            await initializeMedia();
        }
        
        // Verify we actually have tracks
        if (localStream) {
            const tracks = localStream.getTracks();
            console.log(`🔍 Local stream has ${tracks.length} tracks before accepting call`);
            if (tracks.length === 0) {
                console.error('❌ CRITICAL: Local stream has NO tracks after initialization!');
                showStatus('Microphone/camera access failed. Please check permissions.', true);
                return;
            }
            
            // Verify tracks are active
            tracks.forEach((track, index) => {
                console.log(`🎤 Track ${index} (${track.kind}):`, {
                    enabled: track.enabled,
                    readyState: track.readyState,
                    muted: track.muted
                });
                if (track.readyState === 'ended') {
                    console.error(`❌ Track ${index} is ENDED!`);
                }
            });
        } else {
            console.error('❌ CRITICAL: No local stream after initialization!');
            showStatus('Failed to access microphone/camera', true);
            return;
        }
        
        // Check if we have a peer connection and remote description
        if (!peerConnection) {
            console.log('🔧 No peer connection exists, waiting for offer...');
            showStatus('Call accepted, waiting for connection...', false);
            updateCallStatus('Waiting for caller...');
            showCallControls('connected');
            return;
        }
        
        // Verify local stream is added to peer connection
        const senders = peerConnection.getSenders();
        if (senders.length === 0 && localStream) {
            console.warn('⚠️ No senders found in acceptCall! Adding local stream...');
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
        }
        
        // Validate peer connection state before creating answer
        console.log('🔍 Peer connection state:', {
            signalingState: peerConnection.signalingState,
            iceConnectionState: peerConnection.iceConnectionState,
            hasRemoteDescription: !!peerConnection.remoteDescription
        });
        
        // Handle different signaling states
        if (peerConnection.signalingState === 'stable') {
            console.log('✅ Connection already established (stable state)');
            showStatus('Call accepted - connection already established!', false);
            updateCallStatus('Connected');
            
            // Check if we're actually connected
            if (peerConnection.iceConnectionState === 'connected' || 
                peerConnection.iceConnectionState === 'completed') {
                console.log('🎯 WebRTC connection is fully established');
                showStatus('Call connected successfully!', false);
                
                // Start the call if not already started
                if (currentCall && currentCall.status !== 'CONNECTED') {
                    emitCallStart(currentCall.id, {
                        iceConnectionState: peerConnection.iceConnectionState,
                        signalingState: peerConnection.signalingState,
                        connectionState: peerConnection.connectionState
                    });
                }
            }
        } else if (peerConnection.remoteDescription && 
                  (peerConnection.signalingState === 'have-remote-offer' || 
                   peerConnection.signalingState === 'have-local-pranswer')) {
            
            console.log('📝 Creating answer for received offer');
            const answer = await peerConnection.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            await peerConnection.setLocalDescription(answer);
            
            // Debug SDP content
            console.log('🔍 Answer SDP contains audio:', answer.sdp.includes('m=audio'));
            console.log('🔍 Answer SDP contains video:', answer.sdp.includes('m=video'));
            if (answer.sdp.includes('m=audio')) {
                console.log('🎵 Audio media line found in answer');
            } else {
                console.warn('⚠️ No audio media line in answer SDP!');
            }
            
            // Send answer back to caller
            socket.emit('answer', {
                callId: currentCall.id,
                targetUserId: currentCall.userId,
                answer: answer
            });
            
            console.log('📤 Answer sent to caller');
            showStatus('Call accepted, connecting...', false);
            updateCallStatus('Connecting...');
        } else {
            console.log('⚠️ Cannot create answer - invalid state or no remote description');
            console.log('Signaling state:', peerConnection.signalingState);
            console.log('Has remote description:', !!peerConnection.remoteDescription);
            
            showStatus('Call accepted, waiting for caller to connect...', false);
            updateCallStatus('Waiting for connection...');
        }
        
        showCallControls('connected');
        
    } catch (error) {
        console.error('Error accepting call:', error);
        showStatus('Failed to accept call: ' + error.message, true);
        
        // Try to recover by recreating peer connection
        try {
            console.log('🔄 Attempting to recover by recreating peer connection...');
            await createPeerConnection();
            showStatus('Call accepted, connection reset. Waiting for caller...', false);
        } catch (recoveryError) {
            console.error('Failed to recover peer connection:', recoveryError);
        }
    }
}

export function rejectCall() {
    if (!currentCall) {
        showStatus('No incoming call to reject', true);
        return;
    }
    
    console.log('📞 Rejecting call:', currentCall.id);
    
    socket.emit('call-reject', {
        callId: currentCall.id,
        targetUserId: currentCall.userId,
        reason: 'Call rejected by staff'
    });
    
    cleanup();
    showStatus('Call rejected', false);
    showCallControls('idle');
}

export function endCall() {
    if (!currentCall) {
        showStatus('No active call to end', true);
        return;
    }
    
    socket.emit('call-end', {
        callId: currentCall.id
    });
    
    cleanup();
    showStatus('Call ended', false);
    showCallControls('idle');
}

// 🔵 AUDIO DEBUG: Test audio level function
function testAudioLevel(track, trackName = 'Audio Track') {
    if (track.kind !== 'audio') return;
    
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const mediaStreamSource = audioContext.createMediaStreamSource(new MediaStream([track]));
        const analyser = audioContext.createAnalyser();
        
        mediaStreamSource.connect(analyser);
        analyser.fftSize = 256;
        
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        let checkCount = 0;
        const maxChecks = 50; // Check for 5 seconds
        
        const checkAudioLevel = () => {
            if (checkCount >= maxChecks) {
                audioContext.close();
                return;
            }
            
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b) / bufferLength;
            
            if (average > 0) {
                console.log(`🔊 ${trackName} - Audio Level:`, Math.round(average), '/255');
            } else if (checkCount % 10 === 0) {
                console.log(`🔇 ${trackName} - No audio detected (level: ${average})`);
            }
            
            checkCount++;
            setTimeout(checkAudioLevel, 100);
        };
        
        checkAudioLevel();
    } catch (error) {
        console.warn(`⚠️ Could not test audio level for ${trackName}:`, error);
    }
}

// 🔵 AUDIO DEBUG: WebRTC Stats monitoring
let statsInterval = null;

function startStatsMonitoring() {
    if (!peerConnection || statsInterval) return;
    
    console.log('🔵 AUDIO DEBUG: Starting WebRTC stats monitoring...');
    
    statsInterval = setInterval(async () => {
        if (!peerConnection || peerConnection.connectionState === 'closed') {
            clearInterval(statsInterval);
            statsInterval = null;
            return;
        }
        
        try {
            const stats = await peerConnection.getStats();
            let audioInbound = null;
            let audioOutbound = null;
            
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    audioInbound = report;
                } else if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                    audioOutbound = report;
                }
            });
            
            if (audioInbound) {
                console.log('📥 Inbound Audio Stats:', {
                    packetsReceived: audioInbound.packetsReceived,
                    bytesReceived: audioInbound.bytesReceived,
                    packetsLost: audioInbound.packetsLost,
                    jitter: audioInbound.jitter,
                    audioLevel: audioInbound.audioLevel
                });
            }
            
            if (audioOutbound) {
                console.log('📤 Outbound Audio Stats:', {
                    packetsSent: audioOutbound.packetsSent,
                    bytesSent: audioOutbound.bytesSent,
                    audioLevel: audioOutbound.audioLevel
                });
            }
            
            if (!audioInbound && !audioOutbound) {
                console.log('⚠️ No audio RTP stats found');
            }
            
        } catch (error) {
            console.error('❌ Error getting WebRTC stats:', error);
        }
    }, 5000); // Check every 5 seconds
}

export function cleanup() {
    console.log('🔵 AUDIO DEBUG: Cleaning up WebRTC resources...');
    
    // Clear stats monitoring
    if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
    }
    
    if (peerConnection) {
        console.log('🔄 Closing peer connection, final state:', peerConnection.connectionState);
        peerConnection.close();
        peerConnection = null;
    }

    if (localStream) {
        console.log('🛑 Stopping local stream tracks...');
        localStream.getTracks().forEach((track, index) => {
            console.log(`🛑 Stopping ${track.kind} track ${index}:`, track.label);
            track.stop();
        });
        localStream = null;
    }

    currentCall = null;
    iceCandidateBuffer = [];
    iceCandidateCount = 0;
    
    console.log('✅ WebRTC cleanup completed');
}
