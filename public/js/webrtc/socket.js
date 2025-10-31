import { SOCKET_URL } from './config.js';
import { showStatus, updateCallStatus, showCallControls, startCallTimer, stopCallTimer, resetUI } from './ui.js';
import { getUserInfo } from './auth.js';
import { handleOffer, handleAnswer, handleIceCandidate, cleanup as cleanupWebRTC, getCurrentCall, setCurrentCall, createPeerConnection, getPeerConnection, initializeMedia, getLocalStream } from './webrtc.js';

export let socket = null;
let isSocketConnected = false;
let pingInterval = null;
let statusInterval = null;
let currentCallId = null;
let pendingOffers = new Map();
let pendingCandidates = new Map();
let autoRejectTimeouts = new Map(); // Track auto-reject timeouts for cleanup

export function initializeSocket() {
    const { token: userToken, role: userRole, id: userId } = getUserInfo();
    console.log('Initializing socket with token:', userToken);
    
    // Close existing socket if any
    if (socket) {
        console.log('Closing existing socket connection');
        socket.disconnect();
    }
    
    socket = io(SOCKET_URL, {
        auth: { token: userToken },
        extraHeaders: {
            'Authorization': `Bearer ${userToken}`
        },
        query: {
            token: userToken
        },
        transports: ['websocket', 'polling'],
        timeout: 10000,
        withCredentials: true,
        forceNew: true,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 10,
        autoConnect: true
    });

    setupSocketEventHandlers();
}

function setupSocketEventHandlers() {
    const { role: userRole, id: userId } = getUserInfo();

    socket.on('connect', () => {
        isSocketConnected = true;
        showStatus('Connected to server', false);
        
        // Set up periodic ping
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (socket.connected) {
                socket.emit('ping');
            }
        }, 25000);
        
        // Emit user info for debugging
        socket.emit('debug-info', {
            role: userRole,
            userId: userId,
            connectionId: socket.id
        });
        
        // If user role is USER, fetch staff list after connection
        if (userRole === 'USER') {
            fetchAvailableStaff();
        } else if (userRole === 'STAFF') {
            updateStaffStatus();
            
            // Set up periodic status updates
            if (statusInterval) clearInterval(statusInterval);
            statusInterval = setInterval(updateStaffStatus, 30000);
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Disconnected from socket server');
        isSocketConnected = false;
        showStatus('Disconnected from server - attempting to reconnect...', true);
        
        clearIntervals();
        
        // Attempt to reconnect
        setTimeout(() => {
            if (!socket.connected) {
                console.log('🔄 Attempting to reconnect...');
                socket.connect();
            }
        }, 1000);
    });

    socket.on('reconnect', (attemptNumber) => {
        console.log('🔄 Reconnected after', attemptNumber, 'attempts');
        isSocketConnected = true;
        showStatus('Reconnected to server', false);
        
        if (userRole === 'STAFF') {
            updateStaffStatus();
        }
    });

    // Call-specific events
    socket.on('user-joined', handleUserJoined);
    socket.on('user-disconnected', handleUserDisconnected);
    socket.on('call-initiated', handleCallInitiated);
    socket.on('call-accepted', handleCallAccepted);
    socket.on('call-rejected', handleCallRejected);
    socket.on('call-started', handleCallStarted);
    socket.on('call-ended', handleCallEnded);
    socket.on('call-error', handleCallError);
    socket.on('call-quality-alert', handleCallQualityAlert);
    socket.on('call-cost-warning', handleCallCostWarning);
    socket.on('call-force-ended', handleCallForceEnded);
    // Variables are now at module scope

    socket.on('incoming-call', async (data) => {
        console.log('📞 Incoming call received:', data);
        currentCallId = data.callId;
        
        // Staff must join the call room when receiving incoming call
        socket.emit('join-call', { callId: data.callId });
        
        // Check for pending offer
        const pendingOffer = pendingOffers.get(data.callId);
        if (pendingOffer) {
            console.log('📥 Found pending offer for call:', data.callId);
            // Don't delete yet - keep it for manual processing
            data.offer = pendingOffer;
        }

        const success = await handleIncomingCall(data);
        
        if (success) {
            // Store the offer for later processing (when staff manually accepts)
            if (data.offer) {
                console.log('📦 Storing offer for manual acceptance');
                pendingOffers.set(data.callId, data.offer);
            } else {
                console.log('⏳ No offer yet, waiting for offer to arrive...');
            }

            // Store any pending ICE candidates for later processing
            const candidates = pendingCandidates.get(data.callId) || [];
            if (candidates.length > 0) {
                console.log(`📦 Storing ${candidates.length} ICE candidates for manual acceptance`);
                // Keep them in pendingCandidates - don't process yet
            }
        }
    });

    socket.on('initiate-call', async (data) => {
        console.log('📞 Call initiation received:', data);
        currentCallId = data.callId;
        
        // Join the call room first
        socket.emit('join-call', { callId: data.callId });
        
        // Then handle the incoming call
        await handleIncomingCall(data);
    });

    socket.on('staff-unavailable', handleStaffUnavailable);

    socket.on('offer', async (data) => {
        if (!currentCallId) {
            console.log('📦 Storing offer as pending for call:', data.callId);
            pendingOffers.set(data.callId, data.offer);
            return;
        }

        if (data.callId === currentCallId) {
            // Check if call has been manually accepted by staff
            const currentCall = getCurrentCall();
            if (currentCall && currentCall.status === 'ACCEPTED') {
                console.log('✅ Processing offer for manually accepted call');
                
                // Ensure we have a peer connection
                let peerConnection = getPeerConnection();
                if (!peerConnection) {
                    console.log('🔧 Creating peer connection for offer');
                    await createPeerConnection();
                }
                
                // Handle the offer
                await handleOffer(data);

                // Process any buffered ICE candidates
                console.log(`📡 Processing ${bufferedIceCandidates.length} buffered ICE candidates`);
                while (bufferedIceCandidates.length > 0) {
                    const candidate = bufferedIceCandidates.shift();
                    if (candidate.callId === currentCallId) {
                        await handleIceCandidate(candidate);
                    }
                }
            } else {
                console.log('📦 Offer not accepted yet, storing as pending');
                pendingOffers.set(data.callId, data.offer);
            }
        } else {
            pendingOffers.set(data.callId, data.offer);
        }
    });

    socket.on('ice-candidate', async (data) => {
        if (!currentCallId || data.callId !== currentCallId) {
            const candidates = pendingCandidates.get(data.callId) || [];
            candidates.push(data);
            pendingCandidates.set(data.callId, candidates);
            return;
        }

        const peerConnection = getPeerConnection();
        if (!peerConnection) {
            bufferedIceCandidates.push(data);
        } else {
            await handleIceCandidate(data);
        }
    });
    socket.on('answer', (data) => {
        console.log('📝 Received answer:', data);
        handleAnswer(data);
    });

    // Handle processing pending offers after manual acceptance
    socket.on('process-pending-offer', async (data) => {
        console.log('📥 SOCKET HANDLER: process-pending-offer received for call:', data.callId);
        console.log('🔄 Processing pending offer for call:', data.callId);
        const pendingOffer = pendingOffers.get(data.callId);
        if (pendingOffer) {
            console.log('📨 Found pending offer, processing now...');
            console.log('📋 Pending offer details:', pendingOffer);
            pendingOffers.delete(data.callId);
            
            // Process the offer now that call is manually accepted
            const currentCall = getCurrentCall();
            if (currentCall && currentCall.status === 'ACCEPTED') {
                console.log('✅ Call is accepted, processing offer...');
                try {
                    await handleOffer({
                        callId: data.callId,
                        offer: pendingOffer,
                        from: currentCall.userId,
                        fromName: currentCall.caller?.name
                    });
                    console.log('✅ Offer processed successfully');
                } catch (error) {
                    console.error('❌ Error processing pending offer:', error);
                }
                
                // Process any pending ICE candidates
                const candidates = pendingCandidates.get(data.callId) || [];
                if (candidates.length > 0) {
                    console.log(`📡 Processing ${candidates.length} pending ICE candidates`);
                    for (const candidate of candidates) {
                        await handleIceCandidate(candidate);
                    }
                    pendingCandidates.delete(data.callId);
                }
            }
        } else {
            console.log('⚠️ No pending offer found for call:', data.callId);
            console.log('📋 Available pending offers:', Array.from(pendingOffers.keys()));
            console.log('📋 Total pending offers:', pendingOffers.size);
        }
    });
}

function clearIntervals() {
    if (pingInterval) clearInterval(pingInterval);
    if (statusInterval) clearInterval(statusInterval);
}

function updateStaffStatus() {
    const { id: userId } = getUserInfo();
    if (socket && socket.connected) {
        socket.emit('staff-status-update', {
            status: 'online',
            staffId: userId,
            timestamp: new Date().toISOString()
        });
    }
}

// Global variable to track selected staff
let selectedStaffId = null;

function createStaffCard(staff) {
    const card = document.createElement('div');
    card.className = 'staff-card';
    card.dataset.staffId = staff.id;
    
    // Determine status class and availability
    let statusClass = 'offline';
    let statusText = 'OFFLINE';
    let isAvailable = false;
    
    if (staff.status === 'online') {
        if (staff.busy) {
            statusClass = 'busy';
            statusText = 'BUSY';
        } else {
            statusClass = 'available';
            statusText = 'AVAILABLE';
            isAvailable = true;
        }
    }
    
    card.classList.add(statusClass);
    
    // Create card content
    card.innerHTML = `
        <div class="staff-status ${statusClass}"></div>
        <div class="staff-name">${staff.name}</div>
        <div class="staff-rating">⭐ ${staff.ratings} Rating</div>
        <div class="staff-pricing">💰 ${staff.pricing}</div>
        <div class="staff-status-text ${statusClass}">${statusText}</div>
    `;
    
    // Add click handler only for available staff
    if (isAvailable) {
        card.addEventListener('click', () => selectStaff(staff));
    }
    
    return card;
}

function selectStaff(staff) {
    // Remove previous selection
    document.querySelectorAll('.staff-card').forEach(card => {
        card.classList.remove('selected');
    });
    
    // Select new staff
    const selectedCard = document.querySelector(`[data-staff-id="${staff.id}"]`);
    if (selectedCard) {
        selectedCard.classList.add('selected');
    }
    
    // Update selected staff info
    selectedStaffId = staff.id;
    const selectedStaffInfo = document.getElementById('selectedStaffInfo');
    const selectedStaffName = document.getElementById('selectedStaffName');
    const selectedStaffRate = document.getElementById('selectedStaffRate');
    const selectedStaffRating = document.getElementById('selectedStaffRating');
    
    selectedStaffName.textContent = staff.name;
    selectedStaffRate.textContent = staff.pricing;
    selectedStaffRating.textContent = `⭐ ${staff.ratings}`;
    
    selectedStaffInfo.classList.remove('hidden');
    
    // Add class to staff selection to reduce grid height
    const staffSelection = document.getElementById('staffSelection');
    if (staffSelection) {
        staffSelection.classList.add('has-selected');
    }
    
    // Ensure call buttons are visible (they're now always visible at bottom)
    // Just scroll the content area if needed
    setTimeout(() => {
        const controlsContent = document.querySelector('.controls-content');
        if (controlsContent) {
            controlsContent.scrollTop = controlsContent.scrollHeight;
        }
    }, 150);
    
    console.log('📋 Selected staff:', staff.name, 'ID:', staff.id);
}

export function getSelectedStaffId() {
    return selectedStaffId;
}

// Direct function to process pending offers (bypass socket event)
export async function processPendingOfferDirectly(callId) {
    console.log('🔄 Direct processing of pending offer for call:', callId);
    const pendingOffer = pendingOffers.get(callId);
    if (pendingOffer) {
        console.log('📨 Found pending offer, processing directly...');
        pendingOffers.delete(callId);
        
        // Process the offer now that call is manually accepted
        const currentCall = getCurrentCall();
        if (currentCall && currentCall.status === 'ACCEPTED') {
            console.log('✅ Call is accepted, processing offer directly...');
            try {
                await handleOffer({
                    callId: callId,
                    offer: pendingOffer,
                    from: currentCall.userId,
                    fromName: currentCall.caller?.name
                });
                console.log('✅ Offer processed successfully (direct)');
                
                // Process any pending ICE candidates
                const candidates = pendingCandidates.get(callId) || [];
                if (candidates.length > 0) {
                    console.log(`📡 Processing ${candidates.length} pending ICE candidates (direct)`);
                    for (const candidate of candidates) {
                        await handleIceCandidate(candidate);
                    }
                    pendingCandidates.delete(callId);
                }
                return true;
            } catch (error) {
                console.error('❌ Error processing pending offer directly:', error);
                return false;
            }
        } else {
            console.log('⚠️ Call not in accepted state for direct offer processing');
            return false;
        }
    } else {
        console.log('⚠️ No pending offer found for direct processing:', callId);
        console.log('📋 Available pending offers:', Array.from(pendingOffers.keys()));
        return false;
    }
}

// Store handler references for proper cleanup
let staffDataHandler = null;
let staffUpdateHandler = null;

export async function fetchAvailableStaff() {
    if (!socket || !isSocketConnected) {
        showStatus('Socket not connected. Reconnecting...', true);
        return;
    }

    // Remove any existing listeners to prevent duplicates
    if (staffDataHandler) {
        socket.off('staff-data', staffDataHandler);
    }
    if (staffUpdateHandler) {
        socket.off('staff-update', staffUpdateHandler);
    }

    // Define handlers
    staffDataHandler = (response) => {        
        const staffGrid = document.getElementById('staffGrid');
        const staffSelection = document.getElementById('staffSelection');
        
        // Show the staff selection div
        staffSelection.classList.remove('hidden');
        
        staffGrid.innerHTML = '';
        
        if (response.success && response.data && Array.isArray(response.data.staff)) {
            const staffArray = response.data.staff;
            
            staffArray.forEach(staff => {
                const staffCard = createStaffCard(staff);
                staffGrid.appendChild(staffCard);
            });
            
            const availableCount = staffArray.filter(s => s.status === 'online' && !s.busy).length;
            const busyCount = staffArray.filter(s => s.status === 'online' && s.busy).length;
            const offlineCount = staffArray.filter(s => s.status !== 'online').length;
            
            showStatus(`Staff Status: ${availableCount} Available, ${busyCount} Busy, ${offlineCount} Offline`, false);
        } else {
            showStatus('No staff data available', true);
        }
    };

    staffUpdateHandler = (update) => {
        console.log('📊 Staff update received:', update);
        
        if (update.type === 'staff-status-change' || 
            update.type === 'staff-busy-status' || 
            update.type === 'staff-available-status') {
            // Refresh the staff list to show updated status
            socket.emit('get-staff');
        }
    };

    // Listen for staff data response and updates
    socket.on('staff-data', staffDataHandler);
    socket.on('staff-update', staffUpdateHandler);

    // Subscribe to staff updates and get initial list
    socket.emit('subscribe-staff-updates');
    socket.emit('get-staff');
    showStatus('Fetching staff list...', false);
}

// Cleanup function for staff listeners
export function cleanupStaffListeners() {
    if (socket) {
        if (staffDataHandler) {
            socket.off('staff-data', staffDataHandler);
            staffDataHandler = null;
        }
        if (staffUpdateHandler) {
            socket.off('staff-update', staffUpdateHandler);
            staffUpdateHandler = null;
        }
    }
}

// Socket event handlers
function handleUserJoined(data) {
    console.log('User joined call:', data);
    showStatus(`${data.userName} joined the call`, false);
}

function handleUserDisconnected(data) {
    console.log('User disconnected:', data);
    showStatus(`${data.disconnectedUserName} disconnected`, true);
    cleanupWebRTC();
    resetCall();
}

function handleCallInitiated(data) {
    console.log('Call initiated:', data);
    setCurrentCall(data.call);
    showStatus('Call initiated', false);
}

async function handleCallAccepted(data) {
    // CRITICAL: Set the current call ID for the user side
    currentCallId = data.callId;
    
    // Process any pending ICE candidates now that call is accepted
    const candidates = pendingCandidates.get(data.callId) || [];
    if (candidates.length > 0) {
        console.log(`Processing ${candidates.length} pending ICE candidates after call acceptance`);
        // Fix: Use for...of loop to properly await each candidate
        for (const candidate of candidates) {
            try {
                await handleIceCandidate(candidate);
            } catch (error) {
                console.error('Error processing pending ICE candidate:', error);
            }
        }
        pendingCandidates.delete(data.callId);
    }
    
    showStatus(`Call accepted by ${data.acceptedByName}`, false);
    showCallControls('connected');
    startCallTimer();
}

function handleCallRejected(data) {
    console.log('Call rejected:', data);
    showStatus(`Call rejected by ${data.rejectedByName}: ${data.reason}`, true);
    resetCall();
}

function handleCallStarted(data) {
    console.log('Call started:', data);
    const currentCall = getCurrentCall();
    if (currentCall) {
        currentCall.startTime = data.startTime;
    }
    showStatus('Call connected', false);
}

function handleCallEnded(data) {
    console.log('Call ended:', data);
    showStatus(`Call ended. Duration: ${data.duration}s, Cost: ${data.cost} coins`, false);
    cleanupWebRTC();
    resetCall();
}

function handleCallError(error) {
    console.error('Call error:', error);
    showStatus(error.message || 'Call error occurred', true);
    resetCall();
}

function handleCallQualityAlert(data) {
    console.log('Call quality alert:', data);
    showStatus(`Call quality issue: ${data.message}`, true);
}

function handleCallCostWarning(data) {
    console.log('Call cost warning:', data);
    showStatus(`Cost warning: ${data.message}`, true);
}

function handleCallForceEnded(data) {
    console.log('Call force ended:', data);
    showStatus(`Previous call ended: ${data.reason}`, false);
    resetCall();
}

async function handleIncomingCall(data) {
    try {
        let localStream = getLocalStream();
        if (!localStream) {
            await initializeMedia();
            localStream = getLocalStream();
        }
        
        const callDetails = { 
            id: data.callId, 
            caller: data.caller,
            userId: data.caller.id,
            staffUserId: data.staffUserId,
            status: 'INCOMING',
            ...data.callDetails 
        };
        setCurrentCall(callDetails);
        
        await createPeerConnection();
        
        // Show call section and controls
        document.getElementById('callSection').classList.remove('hidden');
        const staffSelection = document.getElementById('staffSelection');
        if (staffSelection) staffSelection.classList.add('hidden');
        
        updateCallStatus(`Incoming call from ${data.caller?.name || 'User'}`);
        showStatus(`${data.caller?.name || 'User'} is calling you`, false);
        
        // Show accept/reject buttons
        const acceptBtn = document.getElementById('acceptCallBtn');
        const rejectBtn = document.getElementById('rejectCallBtn');
        if (acceptBtn && rejectBtn) {
            acceptBtn.classList.remove('hidden');
            rejectBtn.classList.remove('hidden');
        }
        
        document.getElementById('startCallBtn')?.classList.add('hidden');
        document.getElementById('endCallBtn')?.classList.add('hidden');
        
        // Auto-reject after 60 seconds
        const autoRejectTimeout = setTimeout(() => {
            const currentCall = getCurrentCall();
            if (currentCall && currentCall.id === data.callId && currentCall.status === 'INCOMING') {
                console.log('⏰ Auto-rejecting call after 60 seconds');
                handleCallRejected({
                    callId: data.callId,
                    rejectedByName: 'System',
                    reason: 'Call timeout - no response'
                });
            }
            autoRejectTimeouts.delete(data.callId);
        }, 60000);
        
        // Store timeout for cleanup
        autoRejectTimeouts.set(data.callId, autoRejectTimeout);
        
        return true;
    } catch (error) {
        console.error('Error handling incoming call:', error);
        showStatus('Failed to handle incoming call', true);
        return false;
    }
}

function handleStaffUnavailable(data) {
    console.log('Staff unavailable:', data);
    showStatus(data.message, true);
    resetCall();
}

function resetCall() {
    // Get current call before clearing it
    const currentCall = getCurrentCall();
    
    // Clear auto-reject timeout if exists
    if (currentCallId && autoRejectTimeouts.has(currentCallId)) {
        clearTimeout(autoRejectTimeouts.get(currentCallId));
        autoRejectTimeouts.delete(currentCallId);
    }
    
    // Leave call room if socket is connected
    if (socket && socket.connected && currentCall) {
        socket.emit('leave-call', { callId: currentCall.id });
    }
    
    // Clean up pending data for this call
    if (currentCallId) {
        pendingOffers.delete(currentCallId);
        pendingCandidates.delete(currentCallId);
    }
    
    // Clean up WebRTC and UI
    cleanupWebRTC();
    setCurrentCall(null);
    currentCallId = null;
    stopCallTimer();
    resetUI();
}

export function emitCallStart(callId, states) {
    socket.emit('call-start', { 
        callId: callId,
        connectionType: states.connectionState,
        iceState: states.iceConnectionState
    });
}
