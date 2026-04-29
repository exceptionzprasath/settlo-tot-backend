const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const { ddbDocClient, snsClient, tableName, ordersTable } = require('./config/awsConfig');
const { runSetup } = require('./scripts/setupAws');

// --- Order Routes ---

// Create new order
app.post('/api/orders', async (req, res) => {
    try {
        const orderData = {
            ...req.body,
            status: 'placed', // initial status
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        if (!orderData.id) {
            orderData.id = 'ORD' + Math.floor(100000 + Math.random() * 900000);
        }

        await ddbDocClient.send(new PutCommand({
            TableName: ordersTable,
            Item: orderData
        }));

        res.json({ success: true, message: 'Order placed successfully', order: orderData });
    } catch (err) {
        console.error('Create Order Error:', err);
        res.status(500).json({ success: false, message: 'Failed to place order' });
    }
});

// Get nearby orders for employees (within 2km)
app.get('/api/orders/nearby', async (req, res) => {
    try {
        const { lat, lng } = req.query;
        if (!lat || !lng) {
            return res.status(400).json({ success: false, message: 'Latitude and Longitude are required' });
        }

        const userLat = parseFloat(lat);
        const userLng = parseFloat(lng);

        // Fetch all placed orders (in a real app, use a GSI with status='placed')
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: ordersTable,
            FilterExpression: '#status = :status',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':status': 'placed' }
        }));

        const nearbyOrders = result.Items.filter(order => {
            if (!order.locationCoords) return false;
            const distance = calculateDistance(
                userLat,
                userLng,
                order.locationCoords.latitude,
                order.locationCoords.longitude
            );
            return distance <= 2; // 2km radius
        });

        res.json({ success: true, count: nearbyOrders.length, data: nearbyOrders });
    } catch (err) {
        console.error('Fetch Nearby Orders Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch nearby orders' });
    }
});

// Get order by ID (for tracking)
app.get('/api/orders/:id', async (req, res) => {
    try {
        const result = await ddbDocClient.send(new GetCommand({
            TableName: ordersTable,
            Key: { id: req.params.id }
        }));

        if (result.Item) {
            res.json({ success: true, data: result.Item });
        } else {
            res.status(404).json({ success: false, message: 'Order not found' });
        }
    } catch (err) {
        console.error('Get Order Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Accept order (by employee)
app.post('/api/orders/:id/accept', async (req, res) => {
    try {
        const { employeeId, employeeName, employeePhone, employeeAvatar } = req.body;
        const orderId = req.params.id;

        // In a real app, use ConditionExpression to prevent multiple employees from accepting
        const updateParams = {
            TableName: ordersTable,
            Key: { id: orderId },
            UpdateExpression: 'set #status = :status, employeeId = :empId, employeeName = :name, employeePhone = :phone, employeeAvatar = :avatar, acceptedAt = :time, updatedAt = :time',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
                ':status': 'confirmed',
                ':empId': employeeId,
                ':name': employeeName,
                ':phone': employeePhone,
                ':avatar': employeeAvatar || null,
                ':time': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        };

        const result = await ddbDocClient.send(new UpdateCommand(updateParams));

        res.json({ success: true, message: 'Order accepted', data: result.Attributes });
    } catch (err) {
        console.error('Accept Order Error:', err);
        res.status(500).json({ success: false, message: 'Failed to accept order' });
    }
});

// Update order status (strictly Confirmed -> Delivered)
app.patch('/api/orders/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const orderId = req.params.id;

        if (status !== 'delivered') {
            return res.status(400).json({ success: false, message: 'Invalid status update' });
        }

        const result = await ddbDocClient.send(new UpdateCommand({
            TableName: ordersTable,
            Key: { id: orderId },
            UpdateExpression: 'set #status = :status, updatedAt = :time, deliveredAt = :time',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
                ':status': 'delivered',
                ':time': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        }));

        res.json({ success: true, message: 'Order delivered', data: result.Attributes });
    } catch (err) {
        console.error('Update Status Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update status' });
    }
});

// Get orders for a specific customer
app.get('/api/orders/customer/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: ordersTable,
            FilterExpression: 'customerPhone = :phone',
            ExpressionAttributeValues: {
                ':phone': phone
            }
        }));

        // Sort by createdAt descending
        const sortedOrders = (result.Items || []).sort((a, b) => 
            new Date(b.createdAt) - new Date(a.createdAt)
        );

        res.json({ success: true, data: sortedOrders });
    } catch (err) {
        console.error('Fetch Customer Orders Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch your orders' });
    }
});
const { GetCommand, PutCommand, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { PublishCommand } = require('@aws-sdk/client-sns');
const upload = require('./middleware/upload');

// Temporary in-memory OTP store (phone -> {otp, timestamp})
const otpStore = new Map();

// --- Auth Routes ---

// Check if user exists
app.post('/api/auth/check-phone', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone is required' });

    try {
        const result = await ddbDocClient.send(new GetCommand({
            TableName: tableName,
            Key: { phone }
        }));

        if (result.Item) {
            return res.json({ success: true, exists: true, message: 'User exists' });
        } else {
            return res.json({ success: true, exists: false, message: 'User not found' });
        }
    } catch (err) {
        console.error('Check Phone Error:', err);
        res.status(500).json({ success: false, message: 'Server error check-phone' });
    }
});

// Send OTP via SNS
app.post('/api/auth/send-otp', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone is required' });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore.set(phone, { otp, timestamp: Date.now() });

    try {
        const params = {
            Message: `Your Thambioru Tea verification code is: ${otp}`,
            PhoneNumber: phone, // Assuming phone includes country code like +91...
        };

        await snsClient.send(new PublishCommand(params));
        console.log(`OTP ${otp} sent to ${phone}`);

        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (err) {
        console.error('Send OTP Error:', err);
        // Fallback for testing: return OTP in response if SNS fails (only if debugging)
        res.status(500).json({ success: false, message: 'Failed to send OTP via SNS' });
    }
});

// Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP required' });

    const storedData = otpStore.get(phone);
    if (!storedData) return res.status(400).json({ success: false, message: 'OTP not requested or expired' });

    if (storedData.otp === otp) {
        otpStore.delete(phone);
        
        try {
            const result = await ddbDocClient.send(new GetCommand({
                TableName: tableName,
                Key: { phone }
            }));

            // In a real app, generate JWT here
            res.json({ 
                success: true, 
                message: 'OTP verified', 
                token: `token_${Date.now()}`, // Mock token
                user: result.Item
            });
        } catch (err) {
            console.error('Verify OTP User Fetch Error:', err);
            res.status(500).json({ success: false, message: 'OTP verified but failed to fetch user data' });
        }
    } else {
        res.status(400).json({ success: false, message: 'Invalid OTP' });
    }
});

// Register User/Employee
app.post('/api/auth/register', upload.fields([
    { name: 'selfie', maxCount: 1 },
    { name: 'profilePhoto', maxCount: 1 },
    { name: 'insurance', maxCount: 1 },
    { name: 'rc', maxCount: 1 },
    { name: 'aadhar', maxCount: 1 },
    { name: 'aadharCard', maxCount: 1 },
    { name: 'panCard', maxCount: 1 },
    { name: 'license', maxCount: 1 },
    { name: 'familyAadhar', maxCount: 1 }
]), async (req, res) => {
    try {
        const { name, phone, mobile, instagram, facebook, email, role, empId, address, familyRelation, pin } = req.body;
        const files = req.files;

        // Use mobile if phone is not provided (employee app uses 'mobile')
        const userPhone = phone || mobile;

        if (!userPhone || !name) {
            return res.status(400).json({ success: false, message: 'Name and Phone/Mobile are required' });
        }

        const userData = {
            phone: userPhone,
            name,
            instagram,
            facebook,
            email,
            role: role || 'customer',
            empId,
            address,
            familyRelation,
            pin,
            // Documents mapping (flexible)
            selfieUrl: (files && (files.selfie || files.profilePhoto)) ? (files.selfie || files.profilePhoto)[0].location : null,
            insuranceUrl: (files && files.insurance) ? files.insurance[0].location : null,
            rcUrl: (files && files.rc) ? files.rc[0].location : null,
            aadharUrl: (files && (files.aadhar || files.aadharCard)) ? (files.aadhar || files.aadharCard)[0].location : null,
            panCardUrl: (files && files.panCard) ? files.panCard[0].location : null,
            licenseUrl: (files && files.license) ? files.license[0].location : null,
            familyAadharUrl: (files && files.familyAadhar) ? files.familyAadhar[0].location : null,
            createdAt: new Date().toISOString(),
            status: role === 'employee' ? 'pending_verification' : 'active'
        };

        await ddbDocClient.send(new PutCommand({
            TableName: tableName,
            Item: userData
        }));

        res.json({ success: true, message: 'Registration successful', user: userData });
    } catch (err) {
        console.error('Registration Error:', err);
        res.status(500).json({ success: false, message: 'Registration failed' });
    }
});

// Employee Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { employeeId, pin } = req.body;

        if (!employeeId || !pin) {
            return res.status(400).json({ success: false, message: 'Employee ID and PIN are required' });
        }

        const result = await ddbDocClient.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: 'empId = :empId AND pin = :pin',
            ExpressionAttributeValues: {
                ':empId': employeeId,
                ':pin': pin
            }
        }));

        if (result.Items && result.Items.length > 0) {
            const employee = result.Items[0];
            
            if (employee.status === 'pending_verification') {
                return res.json({ 
                    success: false, 
                    message: 'Your account is pending verification. Please wait for admin approval.' 
                });
            }

            res.json({ 
                success: true, 
                message: 'Login successful', 
                token: `token_${Date.now()}`,
                employee
            });
        } else {
            res.status(401).json({ success: false, message: 'Invalid Employee ID or PIN' });
        }
    } catch (err) {
        console.error('Employee Login Error:', err);
        res.status(500).json({ success: false, message: 'Login failed' });
    }
});

// Update user profile
app.patch('/api/auth/profile', async (req, res) => {
    try {
        const { phone, name } = req.body;

        if (!phone || !name) {
            return res.status(400).json({ success: false, message: 'Phone and Name are required' });
        }

        const updateParams = {
            TableName: tableName,
            Key: { phone },
            UpdateExpression: 'set #name = :name, updatedAt = :time',
            ExpressionAttributeNames: { '#name': 'name' },
            ExpressionAttributeValues: {
                ':name': name,
                ':time': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        };

        const result = await ddbDocClient.send(new UpdateCommand(updateParams));

        res.json({ 
            success: true, 
            message: 'Profile updated successfully', 
            user: result.Attributes 
        });
    } catch (err) {
        console.error('Update Profile Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update profile' });
    }
});

// --- Admin Routes ---

// Get pending employee applications
app.get('/api/admin/applications/pending', async (req, res) => {
    try {
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: '#role = :role AND #status = :status',
            ExpressionAttributeNames: {
                '#role': 'role',
                '#status': 'status'
            },
            ExpressionAttributeValues: {
                ':role': 'employee',
                ':status': 'pending_verification'
            }
        }));

        res.json({ success: true, count: result.Items ? result.Items.length : 0, data: result.Items || [] });
    } catch (err) {
        console.error('Fetch Applications Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch applications' });
    }
});

// Approve or reject employee application
app.post('/api/admin/applications/:phone/status', async (req, res) => {
    try {
        const { phone } = req.params;
        const { status } = req.body; // 'active' or 'rejected'

        if (!['active', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status. Must be active or rejected' });
        }

        const updateParams = {
            TableName: tableName,
            Key: { phone },
            UpdateExpression: 'set #status = :status, updatedAt = :time',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
                ':status': status,
                ':time': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        };

        const result = await ddbDocClient.send(new UpdateCommand(updateParams));

        res.json({ 
            success: true, 
            message: `Application ${status} successfully`, 
            user: result.Attributes 
        });
    } catch (err) {
        console.error('Update Application Status Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update application status' });
    }
});

// Mock vehicles data - simulating tea/coffee vendors in Bangalore
const mockVehicles = [
    {
        id: 'v1',
        name: 'Thambi Tea Stall',
        type: 'tea',
        latitude: 12.9716,
        longitude: 77.5946,
        employeeName: 'Raju Kumar',
        phone: '+91 9876543210',
        rating: 4.8,
        distance: 0.5,
        status: 'available',
        specialties: ['Masala Chai', 'Ginger Tea', 'Cutting Chai'],
    },
    {
        id: 'v2',
        name: 'Coffee Express',
        type: 'coffee',
        latitude: 12.9750,
        longitude: 77.5980,
        employeeName: 'Suresh M',
        phone: '+91 9876543211',
        rating: 4.5,
        distance: 0.8,
        status: 'available',
        specialties: ['Filter Coffee', 'Cappuccino', 'Cold Coffee'],
    },
    {
        id: 'v3',
        name: 'Chai Wala',
        type: 'tea',
        latitude: 12.9680,
        longitude: 77.5920,
        employeeName: 'Mohammed Ali',
        phone: '+91 9876543212',
        rating: 4.9,
        distance: 1.2,
        status: 'busy',
        specialties: ['Elaichi Chai', 'Sulaimani', 'Butter Tea'],
    },
    {
        id: 'v4',
        name: 'South Coffee House',
        type: 'coffee',
        latitude: 12.9690,
        longitude: 77.6000,
        employeeName: 'Venkat Rao',
        phone: '+91 9876543213',
        rating: 4.7,
        distance: 1.5,
        status: 'available',
        specialties: ['Mylapore Filter Coffee', 'Degree Coffee'],
    },
    {
        id: 'v5',
        name: 'Express Tea Point',
        type: 'tea',
        latitude: 12.9740,
        longitude: 77.5900,
        employeeName: 'Prakash',
        phone: '+91 9876543214',
        rating: 4.6,
        distance: 0.7,
        status: 'available',
        specialties: ['Kadak Tea', 'Lemon Tea', 'Green Tea'],
    },
    {
        id: 'v6',
        name: 'Authentic Brew',
        type: 'coffee',
        latitude: 12.9700,
        longitude: 77.5970,
        employeeName: 'Ganesh',
        phone: '+91 9876543215',
        rating: 4.4,
        distance: 0.9,
        status: 'available',
        specialties: ['Espresso', 'Latte', 'Mocha'],
    },
];

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'Thambioru Tea Backend is running' });
});

// Get Google Maps API Key (for frontend to use)
app.get('/api/config/maps', (req, res) => {
    res.json({
        apiKey: process.env.GOOGLE_MAPS_API_KEY,
        message: 'Use this key for Google Maps integration'
    });
});

// Get all nearby vehicles
app.get('/api/vehicles', (req, res) => {
    const { lat, lng, type } = req.query;

    let filteredVehicles = [...mockVehicles];

    // Filter by type if provided
    if (type && type !== 'all') {
        filteredVehicles = filteredVehicles.filter(v => v.type === type);
    }

    // Calculate distance if lat/lng provided (mock calculation)
    if (lat && lng) {
        filteredVehicles = filteredVehicles.map(vehicle => {
            const distance = calculateDistance(
                parseFloat(lat),
                parseFloat(lng),
                vehicle.latitude,
                vehicle.longitude
            );
            return { ...vehicle, distance: Math.round(distance * 10) / 10 };
        });

        // Sort by distance
        filteredVehicles.sort((a, b) => a.distance - b.distance);
    }

    res.json({
        success: true,
        count: filteredVehicles.length,
        data: filteredVehicles,
    });
});

// Get single vehicle by ID
app.get('/api/vehicles/:id', (req, res) => {
    const vehicle = mockVehicles.find(v => v.id === req.params.id);

    if (!vehicle) {
        return res.status(404).json({
            success: false,
            message: 'Vehicle not found',
        });
    }

    res.json({
        success: true,
        data: vehicle,
    });
});

// Update vehicle status (for employee app later)
app.patch('/api/vehicles/:id/status', (req, res) => {
    const { status } = req.body;
    const vehicle = mockVehicles.find(v => v.id === req.params.id);

    if (!vehicle) {
        return res.status(404).json({
            success: false,
            message: 'Vehicle not found',
        });
    }

    vehicle.status = status;

    res.json({
        success: true,
        message: 'Status updated',
        data: vehicle,
    });
});

// Haversine formula to calculate distance between two points
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in kilometers
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(deg) {
    return deg * (Math.PI / 180);
}

// Start server
runSetup().then(() => {
    app.listen(PORT, () => {
        console.log(`🍵 Thambioru Tea Backend running on port ${PORT}`);
        console.log(`📍 Google Maps API configured`);
        console.log(`🚗 ${mockVehicles.length} mock vehicles loaded`);
    });
}).catch(err => {
    console.error("Failed to setup AWS resources:", err);
});
