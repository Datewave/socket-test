import { API_BASE_URL } from './config.js';
import { showStatus } from './ui.js';

let userToken = null;
let userId = null;
let userRole = null;

export function getUserInfo() {
    return {
        token: userToken,
        id: userId,
        role: userRole
    };
}

export async function handleLogin() {
    const userType = document.getElementById('userType').value;
    const phone = userType === 'staff' ? '+919876543221' : '+919876543210';
    
    try {
        // First request OTP
        showStatus('Requesting OTP...', false);
        const otpResponse = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone
            })
        });

        const otpData = await otpResponse.json();
        if (!otpData.success) {
            throw new Error(otpData.message || 'Failed to request OTP');
        }

        // Then verify with hardcoded OTP
        showStatus('Verifying OTP...', false);
        const verifyResponse = await fetch(`${API_BASE_URL}/auth/login-with-otp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone,
                otp: '123456'
            })
        });

        const data = await verifyResponse.json();
        if (data.success) {
            userToken = data.data.token;
            userId = data.data.user.id;
            userRole = data.data.user.role;
            
            // Parse the JWT token to check the role
            try {
                const tokenData = JSON.parse(atob(userToken.split('.')[1]));
                console.log('Token data:', tokenData);
                // Use the role from the token as it's more authoritative
                userRole = tokenData.role;
                // If we're staff, use the staffId as our userId
                if (tokenData.isStaff && tokenData.staffId) {
                    userId = tokenData.staffId;
                    console.log('Using staff ID as primary ID:', userId);
                }
            } catch (e) {
                console.error('Error parsing token:', e);
            }

            showStatus('Login successful!', false);
            document.getElementById('loginSection').classList.add('hidden');
            document.getElementById('callSection').classList.remove('hidden');
            
            // If user is not staff, show staff selection
            if (userRole !== 'STAFF') {
                document.getElementById('staffSelection').classList.remove('hidden');
            }

            return {
                success: true,
                userInfo: {
                    token: userToken,
                    id: userId,
                    role: userRole
                }
            };
        } else {
            showStatus(data.message || 'Login failed', true);
            return { success: false };
        }
    } catch (error) {
        console.error('Login error:', error);
        showStatus('Login failed: ' + error.message, true);
        return { success: false };
    }
}
