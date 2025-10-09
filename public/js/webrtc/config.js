// WebRTC Configuration
export const API_BASE_URL = 'https://takemate.api.datewave.in/api/v1';
export const SOCKET_URL = 'https://takemate.api.datewave.in';

// WebRTC peer configuration
export const peerConfig = {
    iceServers: [
        { 
            urls: [
                'stun:takemate.api.datewave.in:3478',
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302'
            ]
        },
        {
            // Primary TURN over UDP
            urls: 'turn:takemate.api.datewave.in:3478',
            username: 'takemate',
            credential: 'S6qZ-9uYbP3!rX2eV4mN'
        },
        {
            // Fallback TURN over TLS for strict networks
            urls: 'turns:takemate.api.datewave.in:5349',
            username: 'takemate',
            credential: 'S6qZ-9uYbP3!rX2eV4mN'
        }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: 'all', // Try both UDP and TCP
    sdpSemantics: 'unified-plan'
};
