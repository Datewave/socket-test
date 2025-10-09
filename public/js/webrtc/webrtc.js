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

        // First try to get both video and audio
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
        } catch (e) {
            console.warn('Failed to get both video and audio, trying audio only:', e);
            // If that fails, try audio only
            localStream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: true
            });
            showStatus('Video unavailable - audio only mode', true);
        }
        
        document.getElementById('localVideo').srcObject = localStream;
        
        console.log('🎤 Media initialized:', 
            'Audio:', localStream.getAudioTracks().length > 0,
            'Video:', localStream.getVideoTracks().length > 0
        );
        return localStream;
    } catch (error) {
        console.error('Error accessing media devices:', error);
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
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        console.log('✅ Added local stream to peer connection');
    } else {
        console.warn('⚠️ No local stream available when creating peer connection');
    }

    // Handle incoming stream
    peerConnection.ontrack = (event) => {
        console.log('🎵 Received remote track:', event.track.kind, 'enabled:', event.track.enabled);
        const remoteVideo = document.getElementById('remoteVideo');
        const remoteStream = event.streams[0];
        
        // Log stream details
        console.log('📺 Remote stream tracks:', {
            audio: remoteStream.getAudioTracks().length,
            video: remoteStream.getVideoTracks().length
        });
        
        remoteVideo.srcObject = remoteStream;
        
        // Ensure audio plays by explicitly setting properties
        remoteVideo.muted = false;
        remoteVideo.volume = 1.0;
        
        // Try to play the remote stream
        remoteVideo.play().then(() => {
            console.log('✅ Remote stream playing successfully');
            // Check if audio tracks are enabled
            const audioTracks = remoteStream.getAudioTracks();
            audioTracks.forEach((track, index) => {
                console.log(`🔊 Audio track ${index}:`, {
                    enabled: track.enabled,
                    muted: track.muted,
                    readyState: track.readyState
                });
            });
        }).catch(error => {
            console.warn('⚠️ Autoplay prevented, user interaction required:', error);
            showStatus('Click the remote video to enable audio', true);
        });
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
            console.log(`Finished collecting ICE candidates. Total: ${iceCandidateCount}`);
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
        
        // Debug SDP content
        console.log('🔍 Answer SDP contains audio:', answer.sdp.includes('m=audio'));
        console.log('🔍 Answer SDP contains video:', answer.sdp.includes('m=video'));
        if (answer.sdp.includes('m=audio')) {
            console.log('🎵 Audio media line found in answer');
        } else {
            console.warn('⚠️ No audio media line in answer SDP!');
        }
        
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
        
        // Debug SDP content
        console.log('🔍 Offer SDP contains audio:', offer.sdp.includes('m=audio'));
        console.log('🔍 Offer SDP contains video:', offer.sdp.includes('m=video'));
        if (offer.sdp.includes('m=audio')) {
            console.log('🎵 Audio media line found in offer');
        } else {
            console.warn('⚠️ No audio media line in offer SDP!');
        }
        
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
        
        // Ensure we have media access before accepting call
        if (!localStream) {
            console.log('🎤 Initializing media for call acceptance...');
            await initializeMedia();
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

export function cleanup() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    currentCall = null;
    iceCandidateBuffer = [];
    iceCandidateCount = 0;
}
