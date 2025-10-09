// WebRTC Configuration
export const API_BASE_URL = 'https://takemate.api.datewave.in/api/v1';
export const SOCKET_URL = 'https://takemate.api.datewave.in';

// WebRTC peer configuration
export const peerConfig = {
    iceServers: [
        { 
            urls: [
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302'
            ]
        },
        {
            urls: [
                'turn:takemate.api.datewave.in:3478?transport=udp',
                'turn:takemate.api.datewave.in:3478?transport=tcp',
                'turns:takemate.api.datewave.in:5349?transport=tcp'
            ],
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
