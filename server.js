const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
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

// Helper: Geocode a string address into lat/lng using Nominatim OpenStreetMap
function geocodeAddress(address) {
    return new Promise((resolve) => {
        if (!address) return resolve(null);
        
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
        
        const options = {
            headers: {
                'User-Agent': 'ThambiOruTeaBackend/1.0'
            }
        };

        https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed && parsed.length > 0) {
                        resolve({
                            latitude: parseFloat(parsed[0].lat),
                            longitude: parseFloat(parsed[0].lon)
                        });
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    console.error('[Geocoding] Parse error:', e.message);
                    resolve(null);
                }
            });
        }).on('error', (err) => {
            console.error('[Geocoding] Request error:', err.message);
            resolve(null);
        });
    });
}


// ============================================
// LIVE RIDER DISPATCH SYSTEM
// In-memory store of online riders
// Map<socketId, { employeeId, employeeName, employeePhone, lat, lng, socketId, onlineSince }>
// ============================================
const onlineRiders = new Map();

// Helper: Get all online riders as an array
function getOnlineRidersArray() {
    return Array.from(onlineRiders.values());
}

// Helper: Dispatch order to nearby riders within radiusKm (and send Push Notifications)
async function dispatchToNearbyRiders(orderData) {
    const orderLat = parseFloat(orderData.customerLocation?.latitude);
    const orderLng = parseFloat(orderData.customerLocation?.longitude);

    if (isNaN(orderLat) || isNaN(orderLng)) {
        console.log('⚠️ Order has no customer location, broadcasting to all riders');
        io.to('riders').emit('new_order', { order: orderData, distance: null });
        return;
    }

    try {
        // Query active online riders from Firestore
        const onlineRidersCol = db.collection('online_riders');
        const snapshot = await onlineRidersCol.where('isOnline', '==', true).get();
        const riders = snapshot.docs.map(doc => doc.data());

        console.log(`🔍 [Geofencing] Checking ${riders.length} online riders in Firestore for Order #${orderData.id}`);

        let notifiedCount = 0;
        let pushCount = 0;

        for (const rider of riders) {
            const distance = calculateDistance(orderLat, orderLng, rider.lat, rider.lng);
            const roundedDistance = Math.round(distance * 10) / 10;

            if (distance <= 3.0) {
                // Check if rider has an active WebSocket connection
                let isConnected = false;
                let activeSocketId = null;

                for (const [sId, activeRider] of onlineRiders.entries()) {
                    if (activeRider.employeeId === rider.employeeId) {
                        isConnected = true;
                        activeSocketId = sId;
                        break;
                    }
                }

                // 1. Socket Broadcast if rider is active in foreground
                if (isConnected && activeSocketId) {
                    io.to(activeSocketId).emit('new_order', {
                        order: { ...orderData, distance: roundedDistance, estimatedTime: Math.round(distance * 4) },
                        distance: roundedDistance
                    });
                    console.log(`📍 Notified active rider ${rider.employeeName} via Socket (${roundedDistance}km away)`);
                }

                // 2. FCM Push Notification if rider has FCM Token
                if (rider.fcmToken) {
                    try {
                        const message = {
                            notification: {
                                title: 'New Order Nearby! ☕',
                                body: `Order #${orderData.id} is available nearby (${roundedDistance}km away). Tap to view and accept!`,
                            },
                            data: {
                                orderId: orderData.id,
                                distance: String(roundedDistance),
                                type: 'new_order'
                            },
                            android: {
                                priority: 'high',
                                notification: {
                                    sound: 'default',
                                    channelId: 'default_notification_channel',
                                    priority: 'max',
                                    defaultSound: true,
                                    defaultVibrateTimings: true,
                                }
                            },
                            token: rider.fcmToken
                        };

                        await admin.messaging().send(message);
                        pushCount++;
                        console.log(`📲 Sent FCM Push Notification to ${rider.employeeName} (${roundedDistance}km away)`);
                    } catch (fcmErr) {
                        console.error(`❌ FCM error for rider ${rider.employeeName}:`, fcmErr.message);
                    }
                } else {
                    console.log(`⚠️ Rider ${rider.employeeName} has no registered FCM token.`);
                }

                notifiedCount++;
            } else {
                console.log(`⏭️ Skipped rider ${rider.employeeName} (${roundedDistance}km away, outside 3km radius)`);
            }
        }

        console.log(`📢 Order ${orderData.id}: Dispatched to ${notifiedCount} riders (${pushCount} push notifications sent)`);
    } catch (err) {
        console.error('Error dispatching to nearby riders:', err);
        // Fallback: broadcast over socket to all active riders
        io.to('riders').emit('new_order', { order: orderData, distance: null });
    }
}

app.use((req, res, next) => {
    req.io = io;
    next();
});

io.on('connection', (socket) => {
    console.log('🔌 Socket connected:', socket.id);

    // --- Customer joins their room ---
    socket.on('join', (data) => {
        if (data && data.phone) {
            socket.join(`customer_${data.phone}`);
            console.log(`👤 Customer ${data.phone} joined room customer_${data.phone}`);
        }
    });

    // --- Rider goes online with location, box & can ---
    socket.on('rider_go_online', async (data) => {
        if (!data || !data.employeeId) return;

        const boxNumber = data.boxNumber || '';
        const currentCan = data.currentCan || '';

        const initialHistory = [
            { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), event: 'Shift Started' },
            { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), event: `Box ${boxNumber} Assigned` },
            { time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), event: `Can ${currentCan} Assigned` }
        ];

        const riderData = {
            employeeId: data.employeeId,
            employeeName: data.employeeName || 'Unknown',
            employeePhone: data.employeePhone || '',
            lat: parseFloat(data.lat) || 0,
            lng: parseFloat(data.lng) || 0,
            socketId: socket.id,
            onlineSince: new Date().toISOString(),
            fcmToken: data.fcmToken || null,
            boxNumber,
            currentCan,
            teaCups: data.teaCups !== undefined ? data.teaCups : 120,
            teasSold: data.teasSold || 0,
            totalTeasSold: data.totalTeasSold || 0,
            canIndex: data.canIndex || 1,
            canRequestStatus: data.canRequestStatus || 'none',
            canHistory: data.canHistory || initialHistory
        };

        onlineRiders.set(socket.id, riderData);
        socket.join('riders');
        console.log(`🟢 Rider ONLINE: ${riderData.employeeName} (${riderData.employeeId}) with box ${boxNumber}, can ${currentCan} | Total online: ${onlineRiders.size}`);

        // Sync to Firestore online_riders
        try {
            await db.collection('online_riders').doc(data.employeeId).set({
                employeeId: riderData.employeeId,
                employeeName: riderData.employeeName,
                employeePhone: riderData.employeePhone,
                lat: riderData.lat,
                lng: riderData.lng,
                fcmToken: riderData.fcmToken,
                isOnline: true,
                boxNumber,
                currentCan,
                teaCups: riderData.teaCups,
                teasSold: riderData.teasSold,
                totalTeasSold: riderData.totalTeasSold,
                canIndex: riderData.canIndex,
                canRequestStatus: riderData.canRequestStatus,
                canHistory: riderData.canHistory,
                lastUpdated: new Date().toISOString()
            }, { merge: true });
            console.log(`🔥 [Firestore] Synced ONLINE status for Rider ${data.employeeId}`);
        } catch (firestoreErr) {
            console.error(`❌ [Firestore] Error syncing rider_go_online:`, firestoreErr.message);
        }

        // Broadcast updated rider count to admin
        io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });
    });

    // --- Rider updates location (every 5 seconds) ---
    socket.on('rider_update_location', async (data) => {
        const rider = onlineRiders.get(socket.id);
        if (rider && data) {
            rider.lat = parseFloat(data.lat) || rider.lat;
            rider.lng = parseFloat(data.lng) || rider.lng;
            onlineRiders.set(socket.id, rider);

            // Sync location update to Firestore
            try {
                await db.collection('online_riders').doc(rider.employeeId).update({
                    lat: rider.lat,
                    lng: rider.lng,
                    lastUpdated: new Date().toISOString()
                });
                console.log(`🔥 [Firestore] Synced location for Rider ${rider.employeeId} to [${rider.lat}, ${rider.lng}]`);
            } catch (firestoreErr) {
                console.error(`❌ [Firestore] Error syncing rider_update_location:`, firestoreErr.message);
            }

            // Broadcast to admin for live map
            io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });
        }
    });

    // --- Rider goes offline ---
    socket.on('rider_go_offline', async () => {
        const rider = onlineRiders.get(socket.id);
        if (rider) {
            console.log(`🔴 Rider OFFLINE: ${rider.employeeName} (${rider.employeeId}) | Total online: ${onlineRiders.size - 1}`);
            onlineRiders.delete(socket.id);
            socket.leave('riders');

            // Sync offline status to Firestore
            try {
                await db.collection('online_riders').doc(rider.employeeId).update({
                    isOnline: false,
                    lastUpdated: new Date().toISOString()
                });
                console.log(`🔥 [Firestore] Synced OFFLINE status for Rider ${rider.employeeId}`);
            } catch (firestoreErr) {
                console.error(`❌ [Firestore] Error syncing rider_go_offline:`, firestoreErr.message);
            }

            io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });
        }
    });

    // --- Admin joins admin room for live updates ---
    socket.on('admin_join', () => {
        socket.join('admin');
        console.log(`🛡️ Admin connected: ${socket.id}`);
        // Send current state immediately
        socket.emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });
    });

    // --- Disconnect cleanup ---
    socket.on('disconnect', () => {
        const rider = onlineRiders.get(socket.id);
        if (rider) {
            console.log(`⚡ Rider disconnected: ${rider.employeeName} (${rider.employeeId}) | Total online: ${onlineRiders.size - 1}`);
            onlineRiders.delete(socket.id);
            io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });
        }
        console.log('🔌 Socket disconnected:', socket.id);
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

// Create new order - saves to Firestore + dispatches to nearby riders
app.post('/api/orders', async (req, res) => {
    try {
        const orderId = req.body.id || ('ORD' + Math.floor(100000 + Math.random() * 900000));
        
        // Handle coordinate mapping if client sends locationCoords/deliveryAddress instead of customerLocation
        let customerLocation = req.body.customerLocation || null;
        if (!customerLocation && req.body.locationCoords) {
            customerLocation = {
                latitude: req.body.locationCoords.latitude,
                longitude: req.body.locationCoords.longitude,
                address: req.body.deliveryAddress || ''
            };
        }

        // Coordinate normalization & automated geocoding fallback
        if (customerLocation) {
            const hasLat = customerLocation.latitude !== undefined && customerLocation.latitude !== null;
            const hasLng = customerLocation.longitude !== undefined && customerLocation.longitude !== null;
            const parsedLat = hasLat ? parseFloat(customerLocation.latitude) : NaN;
            const parsedLng = hasLng ? parseFloat(customerLocation.longitude) : NaN;

            if (isNaN(parsedLat) || isNaN(parsedLng)) {
                console.log(`🔍 [Geocoding] Missing or invalid coordinates for order ${orderId}. Attempting to geocode address: "${customerLocation.address}"`);
                const coords = await geocodeAddress(customerLocation.address);
                if (coords) {
                    customerLocation.latitude = coords.latitude;
                    customerLocation.longitude = coords.longitude;
                    console.log(`✅ [Geocoding] Found coords via Nominatim: [${coords.latitude}, ${coords.longitude}]`);
                } else {
                    console.warn(`❌ [Geocoding] Could not geocode address: "${customerLocation.address}"`);
                }
            } else {
                customerLocation.latitude = parsedLat;
                customerLocation.longitude = parsedLng;
            }
        }

        const orderData = {
            ...req.body,
            id: orderId,
            customerLocation,
            status: 'placed',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await ordersCol.doc(orderId).set(orderData);

        // 🚀 Dispatch to nearby riders within 3km radius
        dispatchToNearbyRiders(orderData);

        // ⏰ 30-second order acceptance timeout
        setTimeout(async () => {
            try {
                const orderRef = ordersCol.doc(orderId);
                const doc = await orderRef.get();
                if (doc.exists) {
                    const currentOrder = doc.data();
                    if (currentOrder.status === 'placed') {
                        // Mark as unassigned
                        await orderRef.update({
                            status: 'unassigned',
                            updatedAt: new Date().toISOString()
                        });
                        console.log(`⏰ [Order Timeout] Order #${orderId} expired without rider acceptance.`);
                        
                        // Notify customer via socket room
                        io.to(`customer_${currentOrder.customerPhone}`).emit('order_status_update', {
                            orderId,
                            status: 'unassigned'
                        });
                        
                        // Broadcast to riders to remove order from their list
                        io.to('riders').emit('order_expired', { orderId });
                    }
                }
            } catch (timeoutErr) {
                console.error(`Error in order ${orderId} timeout:`, timeoutErr);
            }
        }, 30000);

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

// Accept order (by employee) - uses Firestore transaction to prevent double-acceptance
app.post('/api/orders/:id/accept', async (req, res) => {
    try {
        const { employeeId, employeeName, employeePhone, employeeAvatar } = req.body;
        const orderId = req.params.id;
        const orderRef = ordersCol.doc(orderId);

        // Firestore transaction: ensures only ONE rider can accept
        const updatedOrder = await db.runTransaction(async (transaction) => {
            const orderDoc = await transaction.get(orderRef);

            if (!orderDoc.exists) {
                throw new Error('ORDER_NOT_FOUND');
            }

            const currentData = orderDoc.data();
            if (currentData.status !== 'placed') {
                throw new Error('ORDER_ALREADY_ACCEPTED');
            }

            const updateData = {
                status: 'confirmed',
                employeeId,
                employeeName,
                employeePhone,
                employeeAvatar: employeeAvatar || null,
                acceptedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            transaction.update(orderRef, updateData);
            return { ...currentData, ...updateData };
        });

        // ✅ Broadcast to all riders: remove this order from their list
        io.to('riders').emit('order_accepted', { orderId });
        console.log(`📤 Broadcasted order_accepted for ${orderId} to all riders`);

        // ✅ Notify the customer: their order is confirmed with rider details
        if (updatedOrder.customerPhone) {
            io.to(`customer_${updatedOrder.customerPhone}`).emit('order_confirmed', {
                orderId,
                status: 'confirmed',
                rider: {
                    employeeId,
                    employeeName,
                    employeePhone,
                    employeeAvatar: employeeAvatar || null,
                },
                order: updatedOrder,
            });
            console.log(`📤 Notified customer ${updatedOrder.customerPhone}: order ${orderId} confirmed by ${employeeName}`);
        }

        res.json({ success: true, message: 'Order accepted', data: updatedOrder });
    } catch (err) {
        if (err.message === 'ORDER_ALREADY_ACCEPTED') {
            return res.status(409).json({ success: false, message: 'This order has already been accepted by another rider' });
        }
        if (err.message === 'ORDER_NOT_FOUND') {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        console.error('Accept Order Error:', err);
        res.status(500).json({ success: false, message: 'Failed to accept order' });
    }
});

// Get online riders (for admin panel)
app.get('/api/riders/online', (req, res) => {
    const riders = getOnlineRidersArray();
    res.json({
        success: true,
        count: riders.length,
        data: riders
    });
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
        const orderData = updatedDoc.data();

        // ☕ Decrement employee remaining tea cups in can
        if (orderData && orderData.employeeId) {
            let teaCount = 0;
            orderData.items?.forEach(item => {
                const name = item.name.toLowerCase();
                if (name.includes('tea') || name.includes('coffee')) {
                    teaCount += (item.quantity || 1);
                }
            });

            if (teaCount > 0) {
                try {
                    const riderRef = db.collection('online_riders').doc(orderData.employeeId);
                    const riderDoc = await riderRef.get();
                    if (riderDoc.exists) {
                        const rData = riderDoc.data();
                        const currentCups = rData.teaCups !== undefined ? rData.teaCups : 120;
                        const newTeaCups = Math.max(0, currentCups - teaCount);
                        const newTeasSold = (rData.teasSold || 0) + teaCount;
                        const newTotalTeasSold = (rData.totalTeasSold || 0) + teaCount;

                        await riderRef.update({
                            teaCups: newTeaCups,
                            teasSold: newTeasSold,
                            totalTeasSold: newTotalTeasSold,
                            lastUpdated: new Date().toISOString()
                        });

                        // Update in-memory map
                        for (const [sId, activeRider] of onlineRiders.entries()) {
                            if (activeRider.employeeId === orderData.employeeId) {
                                activeRider.teaCups = newTeaCups;
                                activeRider.teasSold = newTeasSold;
                                activeRider.totalTeasSold = newTotalTeasSold;
                                onlineRiders.set(sId, activeRider);
                                break;
                            }
                        }

                        console.log(`🔥 [Inventory] Decremented rider ${orderData.employeeId} by ${teaCount} cups. Now: ${newTeaCups}/120 left`);

                        // Broadcast update to Admin Live view
                        io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });
                    }
                } catch (riderErr) {
                    console.error('Error updating employee tea cups capacity:', riderErr);
                }
            }
        }

        res.json({ success: true, message: 'Order delivered', data: orderData });
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
        let verifiedPhone = phone;

        // TEMPORARY BYPASS: Check if frontend is sending the mock token
        if (idToken !== 'mock-token-for-bypass') {
            // Normal flow: Verify the Firebase ID token
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            verifiedPhone = decodedToken.phone_number || phone;
        }

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
        const { name, phone, mobile, instagram, facebook, email, role, empId, address, familyRelation, pin, alternateNumber, gender, vehicleType, vehicleNumber, dateOfJoining } = req.body;
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
            alternateNumber: alternateNumber || null,
            gender: gender || null,
            vehicleType: vehicleType || null,
            vehicleNumber: vehicleNumber || null,
            dateOfJoining: dateOfJoining || null,
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

// Reset employee PIN
app.post('/api/admin/employees/:phone/reset-pin', async (req, res) => {
    try {
        const { phone } = req.params;
        const { pin } = req.body;

        if (!pin || pin.length !== 4) {
            return res.status(400).json({ success: false, message: 'A 4-digit PIN is required' });
        }

        const updateParams = {
            TableName: tableName,
            Key: { phone },
            UpdateExpression: 'set pin = :pin, updatedAt = :time',
            ExpressionAttributeValues: {
                ':pin': pin,
                ':time': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        };

        await ddbDocClient.send(new UpdateCommand(updateParams));

        res.json({ success: true, message: 'PIN reset successfully' });
    } catch (err) {
        console.error('Reset Employee PIN Error:', err);
        res.status(500).json({ success: false, message: 'Failed to reset PIN' });
    }
});

// Rider requests next can (runs low on tea)
app.post('/api/admin/employees/:phone/can-request', async (req, res) => {
    try {
        const { phone } = req.params;
        const { eta } = req.body;

        const snapshot = await db.collection('online_riders').where('employeePhone', '==', phone).get();
        if (snapshot.empty) {
            return res.status(404).json({ success: false, message: 'Rider is not online' });
        }

        const docRef = snapshot.docs[0].ref;
        const riderData = snapshot.docs[0].data();

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        let newHistory = riderData.canHistory || [];
        newHistory.push({ time: timeStr, event: 'Requested New Can!' });

        await docRef.update({
            canRequestStatus: 'requested',
            canRequestEta: eta || 'N/A',
            canRequestTime: new Date().toISOString(),
            canHistory: newHistory,
            lastUpdated: new Date().toISOString()
        });

        // Update in-memory active sockets
        for (const [sId, activeRider] of onlineRiders.entries()) {
            if (activeRider.employeeId === riderData.employeeId) {
                activeRider.canRequestStatus = 'requested';
                activeRider.canHistory = newHistory;
                onlineRiders.set(sId, activeRider);
                break;
            }
        }

        // Broadcast to admin live requests room
        io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });

        res.json({ success: true, message: 'Can request sent to office' });
    } catch (err) {
        console.error('Can Request Error:', err);
        res.status(500).json({ success: false, message: 'Failed to request can' });
    }
});

// Admin prepares next can for rider
app.post('/api/admin/employees/:phone/can-prepared', async (req, res) => {
    try {
        const { phone } = req.params;
        const { preparedCanId } = req.body;

        if (!preparedCanId) {
            return res.status(400).json({ success: false, message: 'Can Serial Number is required' });
        }

        const snapshot = await db.collection('online_riders').where('employeePhone', '==', phone).get();
        if (snapshot.empty) {
            return res.status(404).json({ success: false, message: 'Rider is not online' });
        }

        const docRef = snapshot.docs[0].ref;
        const riderData = snapshot.docs[0].data();

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        let newHistory = riderData.canHistory || [];
        newHistory.push({ time: timeStr, event: `Can ${preparedCanId} Prepared by Office` });

        await docRef.update({
            canRequestStatus: 'prepared',
            preparedCanId,
            canHistory: newHistory,
            lastUpdated: new Date().toISOString()
        });

        // Update in-memory active sockets
        for (const [sId, activeRider] of onlineRiders.entries()) {
            if (activeRider.employeeId === riderData.employeeId) {
                activeRider.canRequestStatus = 'prepared';
                activeRider.preparedCanId = preparedCanId;
                activeRider.canHistory = newHistory;
                onlineRiders.set(sId, activeRider);
                break;
            }
        }

        // Broadcast to riders and admin
        io.to('riders').emit('can_prepared', { employeeId: riderData.employeeId, preparedCanId });
        io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });

        res.json({ success: true, message: 'Can marked as prepared' });
    } catch (err) {
        console.error('Can Prepared Error:', err);
        res.status(500).json({ success: false, message: 'Failed to prepare can' });
    }
});

// Rider receives and scans the new prepared can at office
app.post('/api/admin/employees/:phone/can-received', async (req, res) => {
    try {
        const { phone } = req.params;
        const { scannedCanId } = req.body;

        if (!scannedCanId) {
            return res.status(400).json({ success: false, message: 'Scanned Can Serial Number is required' });
        }

        const snapshot = await db.collection('online_riders').where('employeePhone', '==', phone).get();
        if (snapshot.empty) {
            return res.status(404).json({ success: false, message: 'Rider is not online' });
        }

        const docRef = snapshot.docs[0].ref;
        const riderData = snapshot.docs[0].data();

        if (riderData.canRequestStatus !== 'prepared') {
            return res.status(400).json({ success: false, message: 'No prepared can is ready for you yet' });
        }

        if (riderData.preparedCanId !== scannedCanId) {
            return res.status(400).json({ success: false, message: `Serial Number doesn't match the prepared can (${riderData.preparedCanId})` });
        }

        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        let newHistory = riderData.canHistory || [];
        newHistory.push({ time: timeStr, event: `Can ${scannedCanId} Assigned` });

        const nextCanIndex = (riderData.canIndex || 1) + 1;

        await docRef.update({
            currentCan: scannedCanId,
            teaCups: 120,
            teasSold: 0,
            canIndex: nextCanIndex,
            canRequestStatus: 'none',
            preparedCanId: null,
            canHistory: newHistory,
            lastUpdated: new Date().toISOString()
        });

        // Update in-memory active sockets
        for (const [sId, activeRider] of onlineRiders.entries()) {
            if (activeRider.employeeId === riderData.employeeId) {
                activeRider.currentCan = scannedCanId;
                activeRider.teaCups = 120;
                activeRider.teasSold = 0;
                activeRider.canIndex = nextCanIndex;
                activeRider.canRequestStatus = 'none';
                activeRider.canHistory = newHistory;
                onlineRiders.set(sId, activeRider);
                break;
            }
        }

        // Broadcast to admin and riders
        io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });

        res.json({ success: true, message: 'Can swapped successfully' });
    } catch (err) {
        console.error('Can Received Error:', err);
        res.status(500).json({ success: false, message: 'Failed to swap can' });
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

// Send broadcast push notification to both apps simultaneously
app.post('/api/admin/broadcast-notification', async (req, res) => {
    const { title, body, imageUrl } = req.body;

    if (!title || !body) {
        return res.status(400).json({ success: false, message: 'Title and body are required' });
    }

    try {
        console.log(`📣 [Broadcast] Sending unified push notification: "${title}" - "${body}"${imageUrl ? ` with image: "${imageUrl}"` : ''}`);

        const message = {
            notification: {
                title: title,
                body: body,
                ...(imageUrl ? { image: imageUrl } : {})
            },
            topic: 'all_users',
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    channelId: 'default_notification_channel',
                    priority: 'max',
                    defaultSound: true,
                    defaultVibrateTimings: true,
                    ...(imageUrl ? { image: imageUrl } : {})
                }
            },
            data: {
                type: 'broadcast',
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                title: title,
                body: body,
                ...(imageUrl ? { imageUrl: imageUrl } : {})
            }
        };

        const response = await admin.messaging().send(message);
        console.log('✅ [Broadcast] Successfully sent broadcast message to topic "all_users":', response);

        res.json({
            success: true,
            message: 'Broadcast notification sent successfully to both apps!',
            messageId: response
        });
    } catch (error) {
        console.error('❌ [Broadcast] Error sending topic message:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send broadcast notification',
            error: error.message
        });
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
