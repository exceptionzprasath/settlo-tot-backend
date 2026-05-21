const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST", "PATCH", "DELETE"]
    }
});
const PORT = process.env.PORT || 3001;

app.use((req, res, next) => {
    req.io = io;
    next();
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    
    socket.on('join', (data) => {
        if (data && data.role === 'employee') {
            socket.join('employees');
            console.log(`Socket ${socket.id} joined employees room`);
        } else if (data && data.phone) {
            socket.join(`customer_${data.phone}`);
            console.log(`Socket ${socket.id} joined customer_${data.phone} room`);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const { ddbDocClient, tableName } = require('./config/awsConfig');
const { initFirebase, getFirebaseAdmin } = require('./config/firebaseAdmin');
const { runSetup } = require('./scripts/setupAws');
const admin = require('firebase-admin');

// Initialize Firestore
const db = initFirebase();
const ordersCol = db.collection('tot_orders');

// Create new order - saves to Firestore
app.post('/api/orders', async (req, res) => {
    try {
        const orderId = req.body.id || ('ORD' + Math.floor(100000 + Math.random() * 900000));
        const orderData = {
            ...req.body,
            id: orderId,
            status: 'placed',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await ordersCol.doc(orderId).set(orderData);

        res.json({ success: true, message: 'Order placed successfully', order: orderData });
    } catch (err) {
        console.error('Create Order Error:', err);
        res.status(500).json({ success: false, message: 'Failed to place order' });
    }
});

// Get all placed orders (Firestore listener handles realtime; this is for one-time fetch)
app.get('/api/orders/nearby', async (req, res) => {
    try {
        const snapshot = await ordersCol.where('status', '==', 'placed').get();
        const orders = snapshot.docs.map(doc => doc.data());
        res.json({ success: true, count: orders.length, data: orders });
    } catch (err) {
        console.error('Fetch Nearby Orders Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch nearby orders' });
    }
});

// Get order by ID
app.get('/api/orders/:id', async (req, res) => {
    try {
        const doc = await ordersCol.doc(req.params.id).get();
        if (doc.exists) {
            res.json({ success: true, data: doc.data() });
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

        const updateData = {
            status: 'confirmed',
            employeeId,
            employeeName,
            employeePhone,
            employeeAvatar: employeeAvatar || null,
            acceptedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await ordersCol.doc(orderId).update(updateData);
        const updatedDoc = await ordersCol.doc(orderId).get();
        const updatedOrder = updatedDoc.data();

        res.json({ success: true, message: 'Order accepted', data: updatedOrder });
    } catch (err) {
        console.error('Accept Order Error:', err);
        res.status(500).json({ success: false, message: 'Failed to accept order' });
    }
});

// Update order status (Confirmed -> Delivered)
app.patch('/api/orders/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const orderId = req.params.id;

        if (status !== 'delivered') {
            return res.status(400).json({ success: false, message: 'Invalid status update' });
        }

        await ordersCol.doc(orderId).update({
            status: 'delivered',
            updatedAt: new Date().toISOString(),
            deliveredAt: new Date().toISOString()
        });

        const updatedDoc = await ordersCol.doc(orderId).get();
        res.json({ success: true, message: 'Order delivered', data: updatedDoc.data() });
    } catch (err) {
        console.error('Update Status Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update status' });
    }
});

// Get orders for a specific customer
app.get('/api/orders/customer/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const snapshot = await ordersCol.where('customerPhone', '==', phone).orderBy('createdAt', 'desc').get();
        const orders = snapshot.docs.map(doc => doc.data());
        res.json({ success: true, data: orders });
    } catch (err) {
        console.error('Fetch Customer Orders Error:', err);
        // Fallback without orderBy if index not ready
        try {
            const snapshot2 = await ordersCol.where('customerPhone', '==', phone).get();
            const orders = snapshot2.docs.map(doc => doc.data()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            res.json({ success: true, data: orders });
        } catch (err2) {
            res.status(500).json({ success: false, message: 'Failed to fetch your orders' });
        }
    }
});
const { GetCommand, PutCommand, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const upload = require('./middleware/upload');

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

// Verify Firebase Phone Auth Token (replaces send-otp + verify-otp)
// The app uses Firebase Auth to send and verify OTP directly.
// Once verified, Firebase gives the app an ID token which is sent here.
app.post('/api/auth/verify-firebase-token', async (req, res) => {
    const { idToken, phone } = req.body;
    if (!idToken) return res.status(400).json({ success: false, message: 'Firebase ID token is required' });

    try {
        // Verify the Firebase ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const verifiedPhone = decodedToken.phone_number || phone;

        // Fetch the user from DynamoDB
        const result = await ddbDocClient.send(new GetCommand({
            TableName: tableName,
            Key: { phone: verifiedPhone }
        }));

        res.json({
            success: true,
            message: 'Phone verified successfully',
            token: idToken,
            user: result.Item || null
        });
    } catch (err) {
        console.error('Firebase Token Verification Error:', err);
        if (err.code === 'auth/id-token-expired') {
            return res.status(401).json({ success: false, message: 'Session expired. Please try again.' });
        }
        res.status(401).json({ success: false, message: 'Invalid or expired token' });
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

// Get current user session
app.get('/api/auth/me/:empId', async (req, res) => {
    try {
        const { empId } = req.params;
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: 'empId = :empId',
            ExpressionAttributeValues: { ':empId': empId }
        }));
        
        if (result.Items && result.Items.length > 0) {
            res.json({ success: true, employee: result.Items[0] });
        } else {
            res.status(404).json({ success: false, message: 'Employee not found' });
        }
    } catch (err) {
        console.error('Fetch Me Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get employee stats (mock implementation)
app.get('/api/employee/stats/:empId', async (req, res) => {
    try {
        // Return mock stats for now
        res.json({
            success: true,
            stats: {
                todayOrders: 0,
                todayEarnings: 0,
                rating: 4.8
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// --- Admin Routes ---

// Get all users (customers)
app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: '#role = :role',
            ExpressionAttributeNames: {
                '#role': 'role'
            },
            ExpressionAttributeValues: {
                ':role': 'customer'
            }
        }));

        res.json({ success: true, count: result.Items ? result.Items.length : 0, data: result.Items || [] });
    } catch (err) {
        console.error('Fetch Users Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch users' });
    }
});

// Get active and suspended employees
app.get('/api/admin/employees/active', async (req, res) => {
    try {
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: '#role = :role AND (#status = :status OR #status = :suspendedStatus)',
            ExpressionAttributeNames: {
                '#role': 'role',
                '#status': 'status'
            },
            ExpressionAttributeValues: {
                ':role': 'employee',
                ':status': 'active',
                ':suspendedStatus': 'suspended'
            }
        }));

        res.json({ success: true, count: result.Items ? result.Items.length : 0, data: result.Items || [] });
    } catch (err) {
        console.error('Fetch Active Employees Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch active employees' });
    }
});

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

// Approve, reject or suspend employee application
app.post('/api/admin/applications/:phone/status', async (req, res) => {
    try {
        const { phone } = req.params;
        const { status } = req.body;

        if (!['active', 'rejected', 'suspended'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status. Must be active, rejected, or suspended' });
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
            message: `Employee status updated to ${status}`, 
            user: result.Attributes 
        });
    } catch (err) {
        console.error('Update Application Status Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update application status' });
    }
});

// Delete an employee
app.delete('/api/admin/employees/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        
        await ddbDocClient.send(new DeleteCommand({
            TableName: tableName,
            Key: { phone }
        }));
        
        res.json({ success: true, message: 'Employee deleted successfully' });
    } catch (err) {
        console.error('Delete Employee Error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete employee' });
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
    server.listen(PORT, () => {
        console.log(`🍵 Thambioru Tea Backend running on port ${PORT}`);
        console.log(`📍 Google Maps API configured`);
        console.log(`🚗 ${mockVehicles.length} mock vehicles loaded`);
    });
}).catch(err => {
    console.error("Failed to setup AWS resources:", err);
});
