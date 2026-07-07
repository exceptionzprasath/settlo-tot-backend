const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
require('dotenv').config();

// Razorpay SDK Integration
const Razorpay = require('razorpay');
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_SvBVS8NOrU9avJ',
    key_secret: process.env.RAZORPAY_KEY_SECRET || '3kVnex8G4MsJj9bkLERrh2vR'
});


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
        const now = new Date();
        const riders = snapshot.docs
            .map(doc => doc.data())
            .filter(r => {
                const lastUpdated = r.lastUpdated ? new Date(r.lastUpdated) : null;
                return lastUpdated && (now.getTime() - lastUpdated.getTime() < 900000); // 15 minutes limit
            });

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

// Helper: Send a push notification to a specific customer by phone number topic
async function sendCustomerPushNotification(phone, title, body) {
    if (!phone) return;
    try {
        const sanitizedPhone = phone.replace(/[^a-zA-Z0-9-_.~%]/g, '');
        const topicName = `customer_${sanitizedPhone}`;
        
        const message = {
            notification: {
                title,
                body
            },
            topic: topicName,
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
            data: {
                type: 'order_status',
                title,
                body
            }
        };

        const response = await admin.messaging().send(message);
        console.log(`📲 [Push Notification] Sent status push to customer ${phone} (Topic: ${topicName}):`, response.messageId || response);
    } catch (err) {
        console.error(`❌ [Push Notification] Failed to send push to customer ${phone}:`, err.message);
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
            selfieUrl: data.selfieUrl || null,
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
                selfieUrl: riderData.selfieUrl,
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
    socket.on('disconnect', async () => {
        const rider = onlineRiders.get(socket.id);
        if (rider) {
            console.log(`⚡ Rider disconnected: ${rider.employeeName} (${rider.employeeId}) | Total online: ${onlineRiders.size - 1}`);
            onlineRiders.delete(socket.id);

            // Sync socket status to Firestore
            try {
                await db.collection('online_riders').doc(rider.employeeId).update({
                    lastUpdated: new Date().toISOString()
                });
                console.log(`🔥 [Firestore] Synced disconnect timestamp for Rider ${rider.employeeId}`);
            } catch (firestoreErr) {
                console.error(`❌ [Firestore] Error syncing disconnect:`, firestoreErr.message);
            }

            io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });
        }
        console.log('🔌 Socket disconnected:', socket.id);
    });
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const { ddbDocClient, tableName, snsClient } = require('./config/awsConfig');
const { PublishCommand } = require('@aws-sdk/client-sns');
const otpStore = {}; // In-memory store for AWS SNS OTP codes
const { initFirebase, getFirebaseAdmin } = require('./config/firebaseAdmin');
const { runSetup } = require('./scripts/setupAws');
const admin = require('firebase-admin');

// Initialize Firestore
const db = initFirebase();
const ordersCol = db.collection('tot_orders');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Timezone-aware IST Calendar Utilities for Spin & Win
function getISTInfo(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = formatter.formatToParts(date);
    const partMap = {};
    parts.forEach(p => { partMap[p.type] = p.value; });
    
    const year = parseInt(partMap.year, 10);
    const month = parseInt(partMap.month, 10);
    const day = parseInt(partMap.day, 10);
    
    const istDateObj = new Date(Date.UTC(year, month - 1, day));
    const dayNum = istDateObj.getUTCDay(); // 0 is Sunday, 1 is Monday, etc.
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    
    // In our system, week starts on Monday, ends on Sunday
    const daysSinceMonday = dayNum === 0 ? 6 : dayNum - 1;
    const mondayDate = new Date(istDateObj.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
    
    const mondayYear = mondayDate.getUTCFullYear();
    const mondayMonth = String(mondayDate.getUTCMonth() + 1).padStart(2, '0');
    const mondayDay = String(mondayDate.getUTCDate()).padStart(2, '0');
    const weekIdentifier = `${mondayYear}-${mondayMonth}-${mondayDay}`;
    
    return {
        year,
        month,
        day,
        dayName: dayNames[dayNum],
        dayNum,
        weekIdentifier
    };
}

function getWeekIdentifierOfDate(date) {
    return getISTInfo(date).weekIdentifier;
}

// Create new order - saves to Firestore as pending_payment + generates Razorpay Order
app.post('/api/orders', async (req, res) => {
    try {
        const customerPhone = req.body.customerPhone;
        if (customerPhone) {
            const ordersSnapshot = await ordersCol
                .where('customerPhone', '==', customerPhone)
                .get();

            const activeOrder = ordersSnapshot.docs.find(doc => {
                const data = doc.data();
                if (data.status === 'confirmed') {
                    return true; // Blocked indefinitely until delivered/cancelled
                }
                if (data.status === 'placed') {
                    const elapsed = Date.now() - new Date(data.createdAt).getTime();
                    return elapsed < 300000; // 5 minutes block
                }
                return false;
            });

            if (activeOrder) {
                const isConfirmed = activeOrder.data().status === 'confirmed';
                return res.status(400).json({
                    success: false,
                    message: isConfirmed
                        ? 'You already have an order accepted and being delivered by a rider. Please wait until it is delivered before placing another one.'
                        : 'You already have an active order waiting for rider confirmation. Please wait for a rider to accept it or for the current order to expire (5 mins) before placing another one.'
                });
            }
        }

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

        // Check if user is eligible for First Tea Free promo or has an active Spin Free Tea
        const phone = req.body.customerPhone;
        let isEligibleForFreeTea = false;
        let isSpinFreeTea = false;
        let ordersSnapshot;
        
        if (phone) {
            ordersSnapshot = await ordersCol.where('customerPhone', '==', phone).get();
            const validOrders = ordersSnapshot.docs.filter(doc => {
                const status = doc.data().status;
                return status === 'delivered' || status === 'placed' || status === 'confirmed';
            });
            
            // Check spin free tea eligibility
            const spinDoc = await db.collection('tot_spins').doc(phone).get();
            if (spinDoc.exists) {
                const spinData = spinDoc.data();
                const ist = getISTInfo(new Date());
                
                if (spinData.currentWeek === ist.weekIdentifier && spinData.currentWeekWinDay) {
                    const activeOrdersWithSpinTea = ordersSnapshot.docs.filter(doc => {
                        const data = doc.data();
                        const isActiveOrDelivered = data.status === 'delivered' || data.status === 'placed' || data.status === 'confirmed';
                        const isThisWeek = getWeekIdentifierOfDate(new Date(data.createdAt)) === ist.weekIdentifier;
                        return isActiveOrDelivered && isThisWeek && data.spinFreeTea === true;
                    });
                    
                    if (activeOrdersWithSpinTea.length === 0) {
                        isEligibleForFreeTea = true;
                        isSpinFreeTea = true;
                    }
                }
            }
        }

        let items = req.body.items || [];
        const isBulk = req.body.isBulk === true;
        if (isBulk) {
            const bulkItem = items.find(item => item.id === 'item_002' || (item.name || '').toLowerCase().includes('bulk'));
            const bulkQuantity = bulkItem ? bulkItem.quantity : 0;
            if (bulkQuantity < 50) {
                return res.status(400).json({
                    success: false,
                    message: 'Minimum bulk order quantity is 50 teas.'
                });
            }
        }

        let firstTeaFree = false;
        let finalTotalAmount = parseFloat(req.body.totalAmount) || 0;

        if (isEligibleForFreeTea) {
            // Find Premium Tea (item_001) in items list
            const teaItemIndex = items.findIndex(item => item.id === 'item_001');
            if (teaItemIndex > -1) {
                firstTeaFree = true;
                // Re-calculate the grand total with free tea applied to ensure data integrity
                let calcTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
                calcTotal = Math.max(0, calcTotal - 15);
                finalTotalAmount = calcTotal;
            }
        }

        const isFreeOrder = finalTotalAmount === 0;
        const paymentMethod = req.body.paymentMethod || 'ONLINE'; // 'ONLINE' or 'COD'
        const hasFlaskTea = items.some(item => 
            (item.name || '').toLowerCase().includes('flask tea')
        );
        const isFlaskOrBulk = hasFlaskTea || isBulk;

        // Direct order placement (no Razorpay payment) for Cash on Delivery (COD) OR Promotional FREE orders (₹0 total)
        if (paymentMethod === 'COD' || isFreeOrder) {
            const orderData = {
                ...req.body,
                id: orderId,
                items,
                totalAmount: finalTotalAmount,
                customerLocation,
                status: req.body.status || 'placed',
                paymentMode: isFreeOrder ? 'free' : (req.body.paymentMode || 'COD'),
                paymentStatus: isFreeOrder ? 'paid' : (req.body.paymentStatus || 'pending'),
                firstTeaFree,
                spinFreeTea: isSpinFreeTea,
                orderType: isFlaskOrBulk ? (isBulk ? 'bulk' : 'flask_tea') : 'normal',
                isBulk: isBulk,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            console.log(`💵 [Order] Placing directly (COD/Free) Order #${orderId} | Total: ₹${finalTotalAmount} | Mode: ${orderData.paymentMode}...`);
            await ordersCol.doc(orderId).set(orderData);

            if (isFlaskOrBulk) {
                console.log(`🍵 [Flask/Bulk Order] Order #${orderId} contains Flask/Bulk Tea. Dispatching directly to Corporate Manager.`);
                io.to('admin').emit('new_flask_tea_order', { order: orderData });
            } else {
                // Dispatch immediately to nearby riders via Firestore geofencing + socket
                dispatchToNearbyRiders(orderData);
            }

            // Start unassigned/expiry timeout of 5 minutes (300 seconds)
            setTimeout(async () => {
                try {
                    const orderRef = ordersCol.doc(orderId);
                    const checkDoc = await orderRef.get();
                    if (checkDoc.exists) {
                        const currentOrder = checkDoc.data();
                        if (currentOrder.status === 'placed') {
                            if (isFlaskOrBulk) {
                                await orderRef.update({
                                    status: 'expired',
                                    updatedAt: new Date().toISOString()
                                });
                                console.log(`⏰ [Order Timeout] Flask/Bulk COD Order #${orderId} expired without Corporate Manager acceptance.`);
                                io.to(`customer_${currentOrder.customerPhone}`).emit('order_status_update', {
                                    orderId,
                                    status: 'expired'
                                });
                                io.to('admin').emit('order_update', { orderId, status: 'expired' });
                                
                                // Send FCM push alert to customer
                                sendCustomerPushNotification(
                                    currentOrder.customerPhone,
                                    'Order Cancelled 🍵',
                                    'Corporate manager did not approve within 5 minutes. It has been cancelled. You can now place a new order.'
                                );
                            } else {
                                await orderRef.update({
                                    status: 'unassigned',
                                    updatedAt: new Date().toISOString()
                                });
                                console.log(`⏰ [Order Timeout] Direct Order #${orderId} expired without rider acceptance.`);
                                io.to(`customer_${currentOrder.customerPhone}`).emit('order_status_update', {
                                    orderId,
                                    status: 'unassigned'
                                });
                                io.to('riders').emit('order_expired', { orderId });

                                // Send FCM push alert to customer
                                sendCustomerPushNotification(
                                    currentOrder.customerPhone,
                                    'Order Cancelled ☕',
                                    'No rider accepted your order. It has been cancelled. You can now place a new order.'
                                );
                            }
                        }
                    }
                } catch (timeoutErr) {
                    console.error(`Error in order ${orderId} timeout:`, timeoutErr);
                }
            }, 300000);

            return res.json({
                success: true,
                pendingPayment: false,
                orderId: orderId,
                order: orderData
            });
        }

        // Create Razorpay Order first (Only for paid online orders)
        const razorpayOptions = {
            amount: Math.round(finalTotalAmount * 100), // in paise
            currency: "INR",
            receipt: orderId
        };

        console.log(`💳 [Razorpay] Creating Razorpay Order for Order #${orderId} with amount ₹${finalTotalAmount}...`);
        const razorpayOrder = await razorpay.orders.create(razorpayOptions);
        console.log(`💳 [Razorpay] Created Razorpay Order: ${razorpayOrder.id}`);

        const orderData = {
            ...req.body,
            id: orderId,
            items,
            totalAmount: finalTotalAmount,
            customerLocation,
            status: 'pending_payment',
            paymentMode: 'online',
            paymentStatus: 'pending',
            firstTeaFree,
            spinFreeTea: isSpinFreeTea,
            razorpayOrderId: razorpayOrder.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await ordersCol.doc(orderId).set(orderData);

        let protocol = req.headers['x-forwarded-proto'] || req.protocol;
        if (req.get('host').includes('railway.app') || req.get('host').includes('foodman.company') || req.get('host').includes('production')) {
            protocol = 'https';
        }

        // Serve Checkout hosted payment page URL on the approved company website domain
        const checkoutUrl = `https://www.foodman.company/checkout?orderId=${orderId}&amount=${finalTotalAmount}&razorpayOrderId=${razorpayOrder.id}&name=${encodeURIComponent(orderData.customerName || '')}&phone=${encodeURIComponent(orderData.customerPhone || '')}&backendUrl=${encodeURIComponent(`${protocol}://${req.get('host')}`)}&keyId=${encodeURIComponent(process.env.RAZORPAY_KEY_ID || 'rzp_test_SvBVS8NOrU9avJ')}`;
        
        res.json({ 
            success: true, 
            pendingPayment: true,
            orderId: orderId, 
            checkoutUrl: checkoutUrl,
            order: orderData 
        });
    } catch (err) {
        console.error('Create Order Error:', err);
        res.status(500).json({ success: false, message: 'Failed to initiate payment & place order', error: err.message });
    }
});

// Hosted checkout page route
app.get('/checkout/:orderId', async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const doc = await ordersCol.doc(orderId).get();
        if (!doc.exists) {
            return res.status(404).send('<h1>Order not found</h1>');
        }
        
        const order = doc.data();
        if (order.status !== 'pending_payment') {
            return res.send(`
                <div style="font-family: sans-serif; text-align: center; margin-top: 50px; background-color: #0A0F14; color: white; height: 100vh; padding: 20px; box-sizing: border-box;">
                    <h1>Order Already Processed</h1>
                    <p>This order is already being processed (Status: ${order.status}).</p>
                </div>
            `);
        }

        let html = fs.readFileSync(path.join(__dirname, 'public', 'checkout.html'), 'utf8');
        html = html.replace('{{KEY_ID}}', process.env.RAZORPAY_KEY_ID || 'rzp_test_SvBVS8NOrU9avJ')
                   .replace('{{AMOUNT}}', order.totalAmount)
                   .replace('{{ORDER_ID}}', order.id)
                   .replace('{{RAZORPAY_ORDER_ID}}', order.razorpayOrderId || '')
                   .replace('{{CUSTOMER_NAME}}', order.customerName || 'Customer')
                   .replace('{{CUSTOMER_PHONE}}', order.customerPhone || '')
                   .replace('{{ITEMS}}', JSON.stringify(order.items || []));
                   
        res.send(html);
    } catch (err) {
        console.error('Error serving checkout page:', err);
        res.status(500).send('<h1>Internal Server Error</h1>');
    }
});

// GET Signature verification and redirect to deep link
app.get('/api/payments/verify', async (req, res) => {
    const { orderId, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.query;
    
    try {
        const orderRef = ordersCol.doc(orderId);
        const doc = await orderRef.get();
        
        if (!doc.exists) {
            return res.status(404).send('<h1>Order not found</h1>');
        }
        
        const order = doc.data();
        
        // Generate signature verification
        const text = razorpay_order_id + "|" + razorpay_payment_id;
        const generated_signature = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "3kVnex8G4MsJj9bkLERrh2vR")
            .update(text)
            .digest("hex");

        if (generated_signature === razorpay_signature) {
            console.log(`✅ [Payment Verified] Order #${orderId} payment succeeded!`);
            
            // Check if order contains Flask Tea or is a Bulk order
            const hasFlaskTea = order.items?.some(item => 
                (item.name || '').toLowerCase().includes('flask tea')
            );
            const isBulk = order.isBulk === true;
            const isFlaskOrBulk = hasFlaskTea || isBulk;

            const updatedOrderData = {
                ...order,
                status: 'placed',
                paymentStatus: 'paid',
                paymentMode: 'online',
                razorpayPaymentId: razorpay_payment_id,
                razorpaySignature: razorpay_signature,
                orderType: isFlaskOrBulk ? (isBulk ? 'bulk' : 'flask_tea') : 'normal',
                isBulk: isBulk,
                updatedAt: new Date().toISOString()
            };
            
            // 1. Update order in Firestore
            await orderRef.set(updatedOrderData);
            
            // 2. Broadcast payment success to customer room
            io.to(`customer_${order.customerPhone}`).emit('payment_success', {
                orderId,
                status: 'placed',
                order: updatedOrderData
            });
            
            if (isFlaskOrBulk) {
                console.log(`🍵 [Flask/Bulk Order] Order #${orderId} contains Flask/Bulk Tea. Dispatching strictly to Corporate Manager (bypassing riders).`);
                
                // Broadcast to admin room for Corporate/Super Admin dashboard updates
                io.to('admin').emit('new_flask_tea_order', { order: updatedOrderData });
                
                // Set order timeout of 5 minutes (300 seconds) for Corporate acceptance
                setTimeout(async () => {
                    try {
                        const checkDoc = await orderRef.get();
                        if (checkDoc.exists) {
                            const currentOrder = checkDoc.data();
                            if (currentOrder.status === 'placed') {
                                await orderRef.update({
                                    status: 'expired',
                                    refundStatus: 'initiated',
                                    updatedAt: new Date().toISOString()
                                });
                                console.log(`⏰ [Flask Tea Timeout] Paid Flask Tea Order #${orderId} expired without Corporate Manager acceptance. Initiating refund...`);
                                io.to(`customer_${currentOrder.customerPhone}`).emit('order_status_update', {
                                    orderId,
                                    status: 'expired'
                                });
                                io.to('admin').emit('order_update', { orderId, status: 'expired' });

                                // Send FCM push alert to customer
                                sendCustomerPushNotification(
                                    currentOrder.customerPhone,
                                    'Order Cancelled 🍵',
                                    'Corporate manager did not approve within 5 minutes. A refund has been initiated and will be credited to your payment method within 2-3 business days. You can now place a new order.'
                                );

                                // Trigger automatic Razorpay Refund
                                if (currentOrder.paymentMode === 'online' && currentOrder.paymentStatus === 'paid' && currentOrder.razorpayPaymentId) {
                                    try {
                                        console.log(`💸 [Refund] Triggering automatic refund for Order #${orderId} (Payment ID: ${currentOrder.razorpayPaymentId})...`);
                                        const refundResponse = await razorpay.payments.refund(currentOrder.razorpayPaymentId, {
                                            notes: {
                                                reason: "Flask Tea Order expired - Corporate Manager did not accept within 5 minutes time limit",
                                                orderId: orderId
                                            }
                                        });
                                        console.log(`✅ [Refund Successful] Refund ID: ${refundResponse.id} for Order #${orderId}`);
                                        await orderRef.update({
                                            refundStatus: 'refunded',
                                            refundId: refundResponse.id,
                                            refundedAt: new Date().toISOString(),
                                            updatedAt: new Date().toISOString()
                                        });
                                    } catch (refundErr) {
                                        console.error(`❌ [Refund Failed] Razorpay error for Order #${orderId}:`, refundErr.message);
                                        await orderRef.update({
                                            refundStatus: 'failed',
                                            refundError: refundErr.message,
                                            updatedAt: new Date().toISOString()
                                        });
                                    }
                                }
                            }
                        }
                    } catch (timeoutErr) {
                        console.error(`Error in paid order ${orderId} timeout:`, timeoutErr);
                    }
                }, 300000); // 5 minutes
                
            } else {
                // 3. Dispatch to nearby riders for normal tea
                dispatchToNearbyRiders(updatedOrderData);
                
                // 4. Set order timeout of 5 minutes (300 seconds) for riders
                setTimeout(async () => {
                    try {
                        const checkDoc = await orderRef.get();
                        if (checkDoc.exists) {
                            const currentOrder = checkDoc.data();
                            if (currentOrder.status === 'placed') {
                                await orderRef.update({
                                    status: 'unassigned',
                                    refundStatus: 'initiated',
                                    updatedAt: new Date().toISOString()
                                });
                                console.log(`⏰ [Order Timeout] Paid Order #${orderId} expired without rider acceptance. Initiating refund...`);
                                io.to(`customer_${currentOrder.customerPhone}`).emit('order_status_update', {
                                    orderId,
                                    status: 'unassigned'
                                });
                                io.to('riders').emit('order_expired', { orderId });

                                // Send FCM push alert to customer
                                sendCustomerPushNotification(
                                    currentOrder.customerPhone,
                                    'Order Cancelled ☕',
                                    'No rider accepted your order. A refund has been initiated and will be credited to your payment method within 2-3 business days. You can now place a new order.'
                                );

                                // Trigger automatic Razorpay Refund
                                if (currentOrder.paymentMode === 'online' && currentOrder.paymentStatus === 'paid' && currentOrder.razorpayPaymentId) {
                                    try {
                                        console.log(`💸 [Refund] Triggering automatic refund for Order #${orderId} (Payment ID: ${currentOrder.razorpayPaymentId})...`);
                                        const refundResponse = await razorpay.payments.refund(currentOrder.razorpayPaymentId, {
                                            notes: {
                                                reason: "Order unassigned - no riders accepted within 5 minutes time limit",
                                                orderId: orderId
                                            }
                                        });
                                        console.log(`✅ [Refund Successful] Refund ID: ${refundResponse.id} for Order #${orderId}`);
                                        await orderRef.update({
                                            refundStatus: 'refunded',
                                            refundId: refundResponse.id,
                                            updatedAt: new Date().toISOString()
                                        });
                                    } catch (refundErr) {
                                        console.error(`❌ [Refund Failed] Razorpay error for Order #${orderId}:`, refundErr.message);
                                        await orderRef.update({
                                            refundStatus: 'failed',
                                            refundError: refundErr.message,
                                            updatedAt: new Date().toISOString()
                                        });
                                    }
                                }
                            }
                        }
                    } catch (timeoutErr) {
                        console.error(`Error in paid order ${orderId} timeout:`, timeoutErr);
                    }
                }, 300000);
            }

            // If JSON response is requested by the brand website, return verified order details
            if (req.query.format === 'json') {
                return res.json({ success: true, message: 'Payment verified successfully', order: updatedOrderData });
            }

            // Serve a beautiful payment successful page that deep-links back to the app
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Payment Successful</title>
                    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700&display=swap" rel="stylesheet">
                    <style>
                        body {
                            background-color: #0A0F14;
                            color: white;
                            font-family: 'Outfit', sans-serif;
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            justify-content: center;
                            height: 100vh;
                            margin: 0;
                            text-align: center;
                            padding: 20px;
                            box-sizing: border-box;
                        }
                        .success-icon {
                            width: 80px;
                            height: 80px;
                            background-color: #00E676;
                            border-radius: 50%;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            margin-bottom: 20px;
                            box-shadow: 0 0 30px rgba(0, 230, 118, 0.4);
                            animation: scaleIn 0.5s ease-out;
                        }
                        @keyframes scaleIn {
                            from { transform: scale(0); }
                            to { transform: scale(1); }
                        }
                        h1 { color: #00E676; font-size: 28px; margin-bottom: 10px; }
                        p { color: #8E9AA6; font-size: 16px; max-width: 320px; line-height: 1.5; margin-bottom: 35px; }
                        .btn {
                            background: linear-gradient(135deg, #FFB300, #FF8F00);
                            color: #0A0F14;
                            border: none;
                            padding: 16px 32px;
                            font-weight: 700;
                            border-radius: 12px;
                            text-decoration: none;
                            font-size: 16px;
                            box-shadow: 0 4px 15px rgba(255, 179, 0, 0.3);
                            cursor: pointer;
                            transition: all 0.3s ease;
                        }
                        .btn:hover {
                            transform: translateY(-2px);
                            box-shadow: 0 6px 20px rgba(255, 179, 0, 0.4);
                        }
                    </style>
                </head>
                <body>
                    <div class="success-icon">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="black">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                        </svg>
                    </div>
                    <h1>Payment Successful!</h1>
                    <p>Your payment has been verified. You can now close this tab and return to the app.</p>
                    <a href="thambiorutea://payment-success?orderId=${orderId}" class="btn">Return to App</a>
                    <script>
                        // Auto redirect to deep link
                        setTimeout(() => {
                            window.location.href = "thambiorutea://payment-success?orderId=${orderId}";
                        }, 1800);
                    </script>
                </body>
                </html>
            `);
        } else {
            console.error(`❌ [Payment Verification Failed] Signature mismatch for Order #${orderId}`);
            if (req.query.format === 'json') {
                return res.status(400).json({ success: false, message: 'Payment verification failed: Signature mismatch.' });
            }
            res.status(400).send('<h1>Payment Verification Failed</h1>');
        }
    } catch (err) {
        console.error('Error verifying payment:', err);
        if (req.query.format === 'json') {
            return res.status(500).json({ success: false, message: 'Server verification error' });
        }
        res.status(500).send('<h1>Internal Server Error</h1>');
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
            
            sendCustomerPushNotification(
                updatedOrder.customerPhone,
                'Order Accepted 🏍️',
                `Your order #${orderId} has been accepted by ${employeeName}. They are on their way!`
            );
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

// Get online riders (for admin panel and client app)
app.get('/api/riders/online', async (req, res) => {
    try {
        const snapshot = await db.collection('online_riders').where('isOnline', '==', true).get();
        const now = new Date();
        const riders = [];

        snapshot.forEach(doc => {
            const data = doc.data();
            const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
            // 15 minutes limit (900,000 ms)
            if (lastUpdated && (now.getTime() - lastUpdated.getTime() < 900000)) {
                riders.push(data);
            }
        });

        res.json({
            success: true,
            count: riders.length,
            data: riders
        });
    } catch (err) {
        console.error('Error fetching online riders:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch online riders' });
    }
});

// Update order status (Confirmed -> Delivered)
app.patch('/api/orders/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const orderId = req.params.id;

        if (status !== 'delivered' && status !== 'cancelled') {
            return res.status(400).json({ success: false, message: 'Invalid status update' });
        }

        if (status === 'cancelled') {
            await ordersCol.doc(orderId).update({
                status: 'cancelled',
                updatedAt: new Date().toISOString(),
                cancelledAt: new Date().toISOString()
            });

            const updatedDoc = await ordersCol.doc(orderId).get();
            const orderData = updatedDoc.data();

            if (orderData && orderData.customerPhone) {
                io.to(`customer_${orderData.customerPhone}`).emit('order_cancelled', {
                    orderId,
                    status: 'cancelled',
                    message: 'Your order was cancelled by the delivery partner.'
                });
                sendCustomerPushNotification(
                    orderData.customerPhone,
                    'Order Cancelled ❌',
                    `Your order #${orderId} was cancelled by the rider. You can now place a new order.`
                );
            }

            return res.json({ success: true, message: 'Order cancelled', data: orderData });
        }

        const updateData = {
            status: 'delivered',
            updatedAt: new Date().toISOString(),
            deliveredAt: new Date().toISOString()
        };
        if (req.body.paymentMode) {
            updateData.paymentMode = req.body.paymentMode;
        }
        await ordersCol.doc(orderId).update(updateData);

        const updatedDoc = await ordersCol.doc(orderId).get();
        const orderData = updatedDoc.data();

        if (orderData && orderData.customerPhone) {
            sendCustomerPushNotification(
                orderData.customerPhone,
                'Order Delivered ☕',
                `Your order #${orderId} was delivered successfully! Enjoy your fresh tea.`
            );
        }

        // ☕ Decrement employee remaining tea cups in can
        if (orderData && orderData.employeeId) {
            let teaCount = 0;
            let mlCount = 0;
            orderData.items?.forEach(item => {
                const name = item.name.toLowerCase();
                if (name.includes('tea') || name.includes('coffee')) {
                    const quantity = item.quantity || 1;
                    const isSmall = item.price === 10 || name.includes('small');
                    const volume = isSmall ? 90 : 130;
                    mlCount += quantity * volume;
                    teaCount += quantity;
                }
            });

            if (teaCount > 0) {
                try {
                    const riderRef = db.collection('online_riders').doc(orderData.employeeId);
                    const riderDoc = await riderRef.get();
                    if (riderDoc.exists) {
                        const rData = riderDoc.data();
                        const currentCups = rData.teaCups !== undefined ? rData.teaCups : 4500; // default to 4500 ml flask capacity
                        const newTeaCups = Math.max(0, currentCups - mlCount);
                        const newTeasSold = (rData.teasSold || 0) + teaCount;
                        const newTotalTeasSold = (rData.totalTeasSold || 0) + teaCount;
                        
                        const orderAmount = orderData.totalAmount || 0;
                        const newTotalSalesAmount = (rData.totalSalesAmount || 0) + orderAmount;

                        await riderRef.update({
                            teaCups: newTeaCups,
                            teasSold: newTeasSold,
                            totalTeasSold: newTotalTeasSold,
                            totalSalesAmount: newTotalSalesAmount,
                            lastUpdated: new Date().toISOString()
                        });

                        // Update in-memory map
                        for (const [sId, activeRider] of onlineRiders.entries()) {
                            if (activeRider.employeeId === orderData.employeeId) {
                                activeRider.teaCups = newTeaCups;
                                activeRider.teasSold = newTeasSold;
                                activeRider.totalTeasSold = newTotalTeasSold;
                                activeRider.totalSalesAmount = newTotalSalesAmount;
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

// Admin status update route (specifically for Corporate/Super Admin handling Flask Tea or override orders)
app.patch('/api/admin/orders/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const orderId = req.params.id;

        const allowedStatuses = ['placed', 'accepted', 'confirmed', 'preparing', 'on_the_way', 'delivered', 'cancelled', 'expired', 'unassigned'];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: `Invalid status update. Allowed: ${allowedStatuses.join(', ')}` });
        }

        const updateData = {
            status,
            updatedAt: new Date().toISOString()
        };

        if (status === 'confirmed' || status === 'preparing') {
            updateData.confirmedAt = new Date().toISOString();
        } else if (status === 'delivered') {
            updateData.deliveredAt = new Date().toISOString();
        } else if (status === 'cancelled') {
            updateData.cancelledAt = new Date().toISOString();
        }

        await ordersCol.doc(orderId).update(updateData);

        const updatedDoc = await ordersCol.doc(orderId).get();
        const orderData = updatedDoc.data();

        // Broadcast status update to the customer socket room
        if (orderData.customerPhone) {
            io.to(`customer_${orderData.customerPhone}`).emit('order_status_update', {
                orderId,
                status,
                order: orderData
            });
            
            // Send customer push notifications for critical transitions
            if (status === 'cancelled') {
                sendCustomerPushNotification(
                    orderData.customerPhone,
                    'Order Cancelled ❌',
                    `Your order #${orderId} was cancelled by the store admin.`
                );
            } else if (status === 'delivered') {
                sendCustomerPushNotification(
                    orderData.customerPhone,
                    'Order Delivered ☕',
                    `Your order #${orderId} was marked as delivered. Enjoy your tea!`
                );
            }

            console.log(`📤 Notified customer ${orderData.customerPhone} of status override: ${status}`);
        }
        
        io.to('admin').emit('order_update', { orderId, status, order: orderData });

        // Trigger automatic Razorpay Refund if status set to expired, unassigned or cancelled
        if ((status === 'expired' || status === 'unassigned' || status === 'cancelled') && orderData.paymentMode === 'online' && orderData.paymentStatus === 'paid' && orderData.razorpayPaymentId) {
            try {
                console.log(`💸 [Refund] Corporate manager initiated refund for Order #${orderId} (Payment ID: ${orderData.razorpayPaymentId})...`);
                const refundResponse = await razorpay.payments.refund(orderData.razorpayPaymentId, {
                    notes: {
                        reason: `Order set to ${status} by Corporate Manager`,
                        orderId: orderId
                    }
                });
                console.log(`✅ [Refund Successful] Refund ID: ${refundResponse.id} for Order #${orderId}`);
                
                // Save refund status and time in Firestore
                const refundTime = new Date().toISOString();
                await ordersCol.doc(orderId).update({
                    refundStatus: 'refunded',
                    refundId: refundResponse.id,
                    refundedAt: refundTime,
                    updatedAt: refundTime
                });
                
                // Fetch final state and broadcast to customer room
                const finalDoc = await ordersCol.doc(orderId).get();
                io.to(`customer_${orderData.customerPhone}`).emit('order_status_update', {
                    orderId,
                    status,
                    order: finalDoc.data()
                });
            } catch (refundErr) {
                console.error(`❌ [Refund Failed] Razorpay error for Order #${orderId}:`, refundErr.message);
                await ordersCol.doc(orderId).update({
                    refundStatus: 'failed',
                    refundError: refundErr.message,
                    updatedAt: new Date().toISOString()
                });
            }
        }

        res.json({ success: true, message: `Order status updated to ${status}`, data: orderData });
    } catch (err) {
        console.error('Corporate Update Status Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update status' });
    }
});
// Record offline sale for an employee (updates Firestore inventory in real-time)
app.post('/api/employees/:employeeId/offline-sale', async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { cupsSold, paymentMode, teaName, price } = req.body;

        if (!cupsSold || cupsSold <= 0) {
            return res.status(400).json({ success: false, message: 'Cups sold must be greater than 0' });
        }

        const riderRef = db.collection('online_riders').doc(employeeId);
        let riderDoc = await riderRef.get();

        if (!riderDoc.exists) {
            console.log(`⚠️ [Offline Sale] Rider document not found in Firestore for ${employeeId}. Querying DynamoDB...`);
            const result = await ddbDocClient.send(new ScanCommand({
                TableName: tableName,
                FilterExpression: 'empId = :empId',
                ExpressionAttributeValues: { ':empId': employeeId }
            }));

            if (result.Items && result.Items.length > 0) {
                const empItem = result.Items[0];
                const initialRiderData = {
                    employeeId: empItem.empId,
                    employeeName: empItem.name || 'Rider',
                    employeePhone: empItem.phone || '',
                    isOnline: false,
                    teaCups: 4500,
                    teasSold: 0,
                    totalTeasSold: 0,
                    totalSalesAmount: 0,
                    lastUpdated: new Date().toISOString()
                };
                await riderRef.set(initialRiderData);
                riderDoc = await riderRef.get();
                console.log(`✅ [Offline Sale] Auto-created online_riders document for ${employeeId}`);
            } else {
                return res.status(404).json({ success: false, message: 'Employee not found in records' });
            }
        }

        if (riderDoc.exists) {
            const rData = riderDoc.data();
            const currentCups = rData.teaCups !== undefined ? rData.teaCups : 4500; // default to 4500 ml flask capacity
            const isSmall = price === 10 || (teaName && teaName.toLowerCase().includes('small'));
            const unitVolume = isSmall ? 90 : 130;
            const volumeSold = cupsSold * unitVolume;
            const newTeaCups = Math.max(0, currentCups - volumeSold);
            const newTeasSold = (rData.teasSold || 0) + cupsSold;
            const newTotalTeasSold = (rData.totalTeasSold || 0) + cupsSold;
            
            const saleAmount = cupsSold * (price !== undefined ? price : 15);
            const newTotalSalesAmount = (rData.totalSalesAmount || 0) + saleAmount;

            await riderRef.update({
                teaCups: newTeaCups,
                teasSold: newTeasSold,
                totalTeasSold: newTotalTeasSold,
                totalSalesAmount: newTotalSalesAmount,
                lastUpdated: new Date().toISOString()
            });

            // Record the offline sale as a completed order in tot_orders for detailed tracking
            const offlineOrderId = `OFF-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
            const itemPrice = price !== undefined ? price : 15;
            const itemName = teaName || 'Premium Tea (Offline)';

            const offlineOrderData = {
                id: offlineOrderId,
                status: 'delivered',
                employeeId,
                employeePhone: rData.employeePhone || '',
                employeeName: rData.employeeName || '',
                customerName: 'Offline Customer',
                customerPhone: 'N/A',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                totalAmount: cupsSold * itemPrice,
                paymentMode: paymentMode === 'upi' ? 'online' : 'cod',
                paymentStatus: 'paid',
                firstTeaFree: false,
                isOfflineSale: true,
                items: [{ name: itemName, quantity: cupsSold, price: itemPrice }]
            };

            await ordersCol.doc(offlineOrderId).set(offlineOrderData);

            // Update in-memory map so Socket.io admin broadcasts get the new inventory count instantly
            for (const [sId, activeRider] of onlineRiders.entries()) {
                if (activeRider.employeeId === employeeId) {
                    activeRider.teaCups = newTeaCups;
                    activeRider.teasSold = newTeasSold;
                    activeRider.totalTeasSold = newTotalTeasSold;
                    activeRider.totalSalesAmount = newTotalSalesAmount;
                    onlineRiders.set(sId, activeRider);
                    break;
                }
            }

            console.log(`🔥 [Inventory Offline Sale] Decremented rider ${employeeId} by ${cupsSold} cups. Now: ${newTeaCups}/120 left. Payment: ${paymentMode}`);

            // Broadcast update to Admin Live view
            io.to('admin').emit('riders_update', { riders: getOnlineRidersArray(), count: onlineRiders.size });

            return res.json({ 
                success: true, 
                message: 'Offline sale recorded successfully', 
                data: {
                    teaCups: newTeaCups,
                    teasSold: newTeasSold,
                    totalTeasSold: newTotalTeasSold
                }
            });
        } else {
            return res.status(404).json({ success: false, message: 'Rider is not online' });
        }
    } catch (err) {
        console.error('Offline Sale Error:', err);
        return res.status(500).json({ success: false, message: 'Failed to record offline sale' });
    }
});

// Get orders for a specific customer
app.get('/api/orders/customer/:phone', async (req, res) => {
    const { phone } = req.params;
    try {
        const snapshot = await ordersCol.where('customerPhone', '==', phone).get();
        const orders = snapshot.docs.map(doc => doc.data()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json({ success: true, data: orders });
    } catch (err) {
        console.error('Fetch Customer Orders Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch your orders' });
    }
});
// Check if a customer is eligible for "First Tea Free" or has a pending "Spin Free Tea" this week
app.get('/api/orders/customer/:phone/free-tea-eligibility', async (req, res) => {
    try {
        const { phone } = req.params;
        const snapshot = await ordersCol.where('customerPhone', '==', phone).get();
        const validOrders = snapshot.docs.filter(doc => {
            const data = doc.data();
            return data.status === 'delivered' || data.status === 'placed' || data.status === 'confirmed';
        });
        // 1. First Tea Free (REMOVED)
        // first tea free is no longer offered to first-time logins.
        // 2. Check Spin Free Tea
        const spinDoc = await db.collection('tot_spins').doc(phone).get();
        if (spinDoc.exists) {
            const spinData = spinDoc.data();
            const ist = getISTInfo(new Date());
            
            // Did they win this week?
            if (spinData.currentWeek === ist.weekIdentifier && spinData.currentWeekWinDay) {
                // Check if they have already placed an active/delivered order this week using the spin free tea
                const activeOrdersWithSpinTea = snapshot.docs.filter(doc => {
                    const data = doc.data();
                    const isActiveOrDelivered = data.status === 'delivered' || data.status === 'placed' || data.status === 'confirmed';
                    const isThisWeek = getWeekIdentifierOfDate(new Date(data.createdAt)) === ist.weekIdentifier;
                    return isActiveOrDelivered && isThisWeek && data.spinFreeTea === true;
                });
                
                if (activeOrdersWithSpinTea.length === 0) {
                    return res.json({ success: true, eligible: true, type: 'spin_tea' });
                }
            }
        }
        
        res.json({ success: true, eligible: false });
    } catch (err) {
        console.error('Free Tea Eligibility Error:', err);
        res.status(500).json({ success: false, message: 'Server error checking eligibility' });
    }
});

// Spin & Win Endpoints

// GET: Check spin status and cooldown for a user
app.get('/api/spin/status/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const spinRef = db.collection('tot_spins').doc(phone);
        const doc = await spinRef.get();
        
        const now = new Date();
        const ist = getISTInfo(now);
        
        if (!doc.exists) {
            return res.json({
                success: true,
                canSpin: true,
                cooldownRemaining: 0,
                hasPendingFreeTea: false,
                isSunday: false,
                lastSpinTime: null
            });
        }
        
        const spinData = doc.data();
        let canSpin = true;
        let cooldownRemaining = 0;
        
        if (spinData.lastSpinTime) {
            const elapsed = now.getTime() - new Date(spinData.lastSpinTime).getTime();
            if (elapsed < 24 * 60 * 60 * 1000) {
                canSpin = false;
                cooldownRemaining = 24 * 60 * 60 * 1000 - elapsed;
            }
        }
        
        // Determine if they currently hold an unused Free Tea reward from this week
        let hasPendingFreeTea = false;
        if (spinData.currentWeek === ist.weekIdentifier && spinData.currentWeekWinDay) {
            // Check if they placed an order using it
            const snapshot = await ordersCol.where('customerPhone', '==', phone).get();
            const activeOrdersWithSpinTea = snapshot.docs.filter(doc => {
                const data = doc.data();
                const isActiveOrDelivered = data.status === 'delivered' || data.status === 'placed' || data.status === 'confirmed';
                const isThisWeek = getWeekIdentifierOfDate(new Date(data.createdAt)) === ist.weekIdentifier;
                return isActiveOrDelivered && isThisWeek && data.spinFreeTea === true;
            });
            hasPendingFreeTea = activeOrdersWithSpinTea.length === 0;
        }
        
        res.json({
            success: true,
            canSpin,
            cooldownRemaining,
            hasPendingFreeTea,
            isSunday: false,
            lastSpinTime: spinData.lastSpinTime
        });
    } catch (err) {
        console.error('Fetch Spin Status Error:', err);
        res.status(500).json({ success: false, message: 'Server error checking spin status' });
    }
});

// POST: Spin the wheel
app.post('/api/spin/:phone', async (req, res) => {
    try {
        const { phone } = req.params;
        const now = new Date();
        const ist = getISTInfo(now);
        
        const spinRef = db.collection('tot_spins').doc(phone);
        const doc = await spinRef.get();
        let spinData = doc.exists ? doc.data() : {
            phone,
            lastSpinTime: null,
            history: [],
            currentWeek: '',
            currentWeekWinDay: null,
            previousWeekWinDay: null
        };
        
        // Check cooldown
        if (spinData.lastSpinTime) {
            const elapsed = now.getTime() - new Date(spinData.lastSpinTime).getTime();
            if (elapsed < 24 * 60 * 60 * 1000) {
                const remaining = 24 * 60 * 60 * 1000 - elapsed;
                return res.status(400).json({
                    success: false,
                    message: 'Spin is on cooldown. Please wait.',
                    cooldownRemaining: remaining
                });
            }
        }
        
        // Handle weekly transition
        if (spinData.currentWeek !== ist.weekIdentifier) {
            spinData.previousWeekWinDay = spinData.currentWeekWinDay || null;
            spinData.currentWeek = ist.weekIdentifier;
            spinData.currentWeekWinDay = null;
        }
        
        // Decide spin outcome
        let result = 'better_luck';
        const alreadyWonThisWeek = !!spinData.currentWeekWinDay;
        
        if (!alreadyWonThisWeek) {
            const allDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
            const validDays = allDays.filter(day => day !== spinData.previousWeekWinDay);
            
            if (validDays.includes(ist.dayName)) {
                const currentDayIndexInAll = allDays.indexOf(ist.dayName);
                const remainingValidDays = validDays.filter(day => allDays.indexOf(day) >= currentDayIndexInAll);
                
                if (remainingValidDays.length === 1) {
                    // Today is the last possible winning day this week, must win!
                    result = 'free_tea';
                } else {
                    // Random probability: 1 / number of remaining valid days
                    const probability = 1 / remainingValidDays.length;
                    const roll = Math.random();
                    if (roll < probability) {
                        result = 'free_tea';
                    }
                }
            }
        }
        
        // Select matching slot index: 3 Free Slots (0, 2, 4), 3 Try Again Slots (1, 3, 5)
        let slotIndex = 0;
        if (result === 'free_tea') {
            const freeSlots = [0, 2, 4];
            slotIndex = freeSlots[Math.floor(Math.random() * freeSlots.length)];
            spinData.currentWeekWinDay = ist.dayName;
        } else {
            const betterLuckSlots = [1, 3, 5];
            slotIndex = betterLuckSlots[Math.floor(Math.random() * betterLuckSlots.length)];
        }
        
        // Log to history
        const spinRecord = {
            timestamp: now.toISOString(),
            result,
            dayOfWeek: ist.dayName,
            weekIdentifier: ist.weekIdentifier,
            slotIndex
        };
        
        spinData.lastSpinTime = now.toISOString();
        if (!spinData.history) spinData.history = [];
        spinData.history.push(spinRecord);
        
        // Save back to Firestore
        await spinRef.set(spinData);
        
        res.json({
            success: true,
            result,
            slotIndex,
            lastSpinTime: spinData.lastSpinTime,
            cooldownRemaining: 24 * 60 * 60 * 1000
        });
    } catch (err) {
        console.error('Execute Spin Error:', err);
        res.status(500).json({ success: false, message: 'Server error executing spin' });
    }
});

const { GetCommand, PutCommand, ScanCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const upload = require('./middleware/upload');

// Caching variables for active employees ScanCommand
let activeEmployeesCache = null;
let activeEmployeesCacheTime = 0;
const ACTIVE_EMPLOYEES_CACHE_TTL = 10000; // 10 seconds in ms

function clearActiveEmployeesCache() {
    activeEmployeesCache = null;
    activeEmployeesCacheTime = 0;
}

// Caching variables for admin users ScanCommand
let adminUsersCache = null;
let adminUsersCacheTime = 0;
let adminUsersFetchPromise = null;
const ADMIN_USERS_CACHE_TTL = 300000; // 5 minutes in ms

function clearAdminUsersCache() {
    adminUsersCache = null;
    adminUsersCacheTime = 0;
    adminUsersFetchPromise = null;
}

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
            return res.json({ success: true, exists: true, user: result.Item, message: 'User exists' });
        } else {
            return res.json({ success: true, exists: false, message: 'User not found' });
        }
    } catch (err) {
        console.error('Check Phone Error:', err);
        res.status(500).json({ success: false, message: 'Server error check-phone' });
    }
});

// --- AWS SNS OTP Flows ---

// Send OTP via AWS SNS
app.post('/api/auth/send-otp', async (req, res) => {
    const { phone, appSignature } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone number is required' });

    try {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Store in-memory with 5 minutes expiration
        otpStore[phone] = {
            otp,
            expiresAt: Date.now() + 5 * 60 * 1000
        };

        const message = appSignature 
            ? `<#> Your Thambioru Tea verification code is: ${otp}. Valid for 5 minutes.\n${appSignature}`
            : `Your Thambioru Tea verification code is: ${otp}. Valid for 5 minutes.`;

        console.log(`💬 [SNS] Sending OTP code ${otp} to ${phone} (App Signature: ${appSignature || 'none'})...`);
        
        const command = new PublishCommand({
            Message: message,
            PhoneNumber: phone,
        });

        await snsClient.send(command);

        console.log(`💬 [SNS] OTP SMS sent successfully to ${phone}`);
        res.json({ success: true, message: 'OTP sent successfully' });
    } catch (err) {
        console.error('Send OTP via SNS Error:', err);
        res.status(500).json({ success: false, message: 'Failed to send OTP via SMS. Please check your phone format.' });
    }
});

// Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP are required' });

    try {
        const storedData = otpStore[phone];
        if (!storedData) {
            return res.status(400).json({ success: false, message: 'OTP not requested or expired.' });
        }

        if (Date.now() > storedData.expiresAt) {
            delete otpStore[phone];
            return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
        }

        if (storedData.otp !== otp) {
            return res.status(400).json({ success: false, message: 'Invalid verification code. Please check and try again.' });
        }

        // Clean up OTP on success
        delete otpStore[phone];

        // Update user to be verified in DynamoDB
        await ddbDocClient.send(new UpdateCommand({
            TableName: tableName,
            Key: { phone },
            UpdateExpression: 'set isVerified = :verified',
            ExpressionAttributeValues: {
                ':verified': true
            }
        }));

        // Fetch the user from DynamoDB
        const result = await ddbDocClient.send(new GetCommand({
            TableName: tableName,
            Key: { phone }
        }));

        res.json({
            success: true,
            message: 'Phone verified successfully',
            token: 'sns-verified-token-' + Math.floor(100000 + Math.random() * 900000),
            user: result.Item || null
        });
    } catch (err) {
        console.error('Verify OTP Error:', err);
        res.status(500).json({ success: false, message: 'OTP verification failed' });
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

        // Update user to be verified in DynamoDB
        await ddbDocClient.send(new UpdateCommand({
            TableName: tableName,
            Key: { phone: verifiedPhone },
            UpdateExpression: 'set isVerified = :verified',
            ExpressionAttributeValues: {
                ':verified': true
            }
        }));

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
        const { name, phone, mobile, instagram, facebook, email, role, empId, address, familyRelation, pin, alternateNumber, gender, vehicleType, vehicleNumber, dateOfJoining, employeeType } = req.body;
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
            employeeType: employeeType || 'Full Time',
            registeredEmployeeType: employeeType || 'Full Time',
            // Documents mapping (flexible)
            selfieUrl: (files && (files.selfie || files.profilePhoto)) ? (files.selfie || files.profilePhoto)[0].location : null,
            insuranceUrl: (files && files.insurance) ? files.insurance[0].location : null,
            rcUrl: (files && files.rc) ? files.rc[0].location : null,
            aadharUrl: (files && (files.aadhar || files.aadharCard)) ? (files.aadhar || files.aadharCard)[0].location : null,
            panCardUrl: (files && files.panCard) ? files.panCard[0].location : null,
            licenseUrl: (files && files.license) ? files.license[0].location : null,
            familyAadharUrl: (files && files.familyAadhar) ? files.familyAadhar[0].location : null,
            createdAt: new Date().toISOString(),
            isVerified: false,
            status: role === 'employee' ? 'pending_verification' : 'active'
        };

        await ddbDocClient.send(new PutCommand({
            TableName: tableName,
            Item: userData
        }));

        clearAdminUsersCache();

        res.json({ success: true, message: 'Registration successful', user: userData });
    } catch (err) {
        console.error('Registration Error:', err);
        res.status(500).json({ success: false, message: 'Registration failed' });
    }
});

// Update Employee Details & Documents
app.put('/api/admin/employees/:phone', upload.fields([
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
        const { phone } = req.params;
        const {
            name, email, empId, address, alternateNumber, gender,
            vehicleType, vehicleNumber, dateOfJoining, employeeType,
            familyRelation, instagram, facebook,
            holderName, bankName, accountNumber, ifscCode, upiId
        } = req.body;
        const files = req.files;

        // Fetch existing employee
        const getResult = await ddbDocClient.send(new GetCommand({
            TableName: tableName,
            Key: { phone }
        }));

        if (!getResult.Item) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }

        const existingUser = getResult.Item;

        // Construct updated bank details
        let updatedBankDetails = existingUser.bankDetails || null;
        if (holderName !== undefined || bankName !== undefined || accountNumber !== undefined || ifscCode !== undefined || upiId !== undefined) {
            updatedBankDetails = {
                ...(existingUser.bankDetails || {}),
                ...(holderName !== undefined && { holderName }),
                ...(bankName !== undefined && { bankName }),
                ...(accountNumber !== undefined && { accountNumber }),
                ...(ifscCode !== undefined && { ifscCode }),
                ...(upiId !== undefined && { upiId })
            };
        }

        // Construct updated user data
        const updatedUserData = {
            ...existingUser,
            ...(name !== undefined && { name }),
            ...(email !== undefined && { email }),
            ...(empId !== undefined && { empId }),
            ...(address !== undefined && { address }),
            ...(alternateNumber !== undefined && { alternateNumber: alternateNumber || null }),
            ...(gender !== undefined && { gender: gender || null }),
            ...(vehicleType !== undefined && { vehicleType: vehicleType || null }),
            ...(vehicleNumber !== undefined && { vehicleNumber: vehicleNumber || null }),
            ...(dateOfJoining !== undefined && { dateOfJoining: dateOfJoining || null }),
            ...(employeeType !== undefined && { 
                employeeType: employeeType || 'Full Time',
                registeredEmployeeType: employeeType || 'Full Time'
            }),
            ...(familyRelation !== undefined && { familyRelation }),
            ...(instagram !== undefined && { instagram }),
            ...(facebook !== undefined && { facebook }),
            ...(updatedBankDetails !== undefined && { bankDetails: updatedBankDetails }),
            
            // Document replacements
            ...((files && (files.selfie || files.profilePhoto)) && { selfieUrl: (files.selfie || files.profilePhoto)[0].location }),
            ...((files && files.insurance) && { insuranceUrl: files.insurance[0].location }),
            ...((files && files.rc) && { rcUrl: files.rc[0].location }),
            ...((files && (files.aadhar || files.aadharCard)) && { aadharUrl: (files.aadhar || files.aadharCard)[0].location }),
            ...((files && files.panCard) && { panCardUrl: files.panCard[0].location }),
            ...((files && files.license) && { licenseUrl: files.license[0].location }),
            ...((files && files.familyAadhar) && { familyAadharUrl: files.familyAadhar[0].location }),
            
            updatedAt: new Date().toISOString()
        };

        await ddbDocClient.send(new PutCommand({
            TableName: tableName,
            Item: updatedUserData
        }));

        clearActiveEmployeesCache();

        res.json({ success: true, message: 'Employee details and documents updated successfully', user: updatedUserData });
    } catch (err) {
        console.error('Update Employee Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update employee details' });
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

            if (employee.status === 'rejected') {
                return res.json({
                    success: false,
                    message: `Your registration was rejected. Reason: ${employee.rejectionReason || 'No reason specified'}`
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

        clearAdminUsersCache();

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

// Update employee bank details
app.patch('/api/auth/bank-details', async (req, res) => {
    try {
        const { phone, bankDetails } = req.body;

        if (!phone || !bankDetails) {
            return res.status(400).json({ success: false, message: 'Phone and Bank Details are required' });
        }

        const updateParams = {
            TableName: tableName,
            Key: { phone },
            UpdateExpression: 'set bankDetails = :bankDetails, updatedAt = :time',
            ExpressionAttributeValues: {
                ':bankDetails': bankDetails,
                ':time': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        };

        const result = await ddbDocClient.send(new UpdateCommand(updateParams));

        res.json({
            success: true,
            message: 'Bank details updated successfully',
            user: result.Attributes
        });
    } catch (err) {
        console.error('Update Bank Details Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update bank details' });
    }
});

// Update employee type (Full Time / Part Time)
app.patch('/api/auth/employee-type', async (req, res) => {
    try {
        const { phone, employeeType } = req.body;

        if (!phone || !employeeType) {
            return res.status(400).json({ success: false, message: 'Phone and Employee Type are required' });
        }

        if (employeeType !== 'Full Time' && employeeType !== 'Part Time') {
            return res.status(400).json({ success: false, message: 'Invalid Employee Type' });
        }

        // Get the current employee record to check registered type and perform migration if needed
        const getResult = await ddbDocClient.send(new GetCommand({
            TableName: tableName,
            Key: { phone }
        }));

        if (!getResult.Item) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }

        const employee = getResult.Item;
        const currentRegisteredType = employee.registeredEmployeeType || employee.employeeType || 'Full Time';

        // Guard: If registered type is Part Time, they cannot switch to Full Time
        if (currentRegisteredType === 'Part Time' && employeeType === 'Full Time') {
            return res.status(400).json({ success: false, message: 'Part-time employees are not eligible to switch to Full-time.' });
        }

        const updateParams = {
            TableName: tableName,
            Key: { phone },
            UpdateExpression: 'set employeeType = :employeeType, registeredEmployeeType = :registeredType, updatedAt = :time',
            ExpressionAttributeValues: {
                ':employeeType': employeeType,
                ':registeredType': currentRegisteredType,
                ':time': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        };

        const result = await ddbDocClient.send(new UpdateCommand(updateParams));

        res.json({
            success: true,
            message: `Employee type updated to ${employeeType} successfully`,
            user: result.Attributes
        });
    } catch (err) {
        console.error('Update Employee Type Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update employee type' });
    }
});

// Update employee work history
app.patch('/api/auth/work-history', async (req, res) => {
    try {
        const { phone, workHistory } = req.body;

        if (!phone || !workHistory) {
            return res.status(400).json({ success: false, message: 'Phone and Work History are required' });
        }

        const updateParams = {
            TableName: tableName,
            Key: { phone },
            UpdateExpression: 'set workHistory = :workHistory, updatedAt = :time',
            ExpressionAttributeValues: {
                ':workHistory': workHistory,
                ':time': new Date().toISOString()
            },
            ReturnValues: 'ALL_NEW'
        };

        const result = await ddbDocClient.send(new UpdateCommand(updateParams));

        res.json({
            success: true,
            message: 'Work history updated successfully',
            user: result.Attributes
        });
    } catch (err) {
        console.error('Update Work History Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update work history' });
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

// ============================================
// REGULAR CUSTOMERS ENDPOINTS
// ============================================
app.post('/api/employee/regular-customers', async (req, res) => {
    try {
        const { name, phone, location, scheduleType, date, recurringDays, time, employeeId } = req.body;
        if (!name || !phone || !location || !time || !employeeId) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }

        const newCustomer = {
            name,
            phone,
            location,
            scheduleType: scheduleType || 'one_time',
            date: date || '',
            recurringDays: recurringDays || [],
            time,
            employeeId,
            createdAt: new Date().toISOString()
        };

        const docRef = await db.collection('tot_regular_customers').add(newCustomer);
        res.json({ success: true, id: docRef.id, customer: newCustomer });
    } catch (error) {
        console.error('Error adding regular customer:', error);
        res.status(500).json({ success: false, message: 'Failed to save customer' });
    }
});

app.get('/api/employee/regular-customers/:employeeId', async (req, res) => {
    try {
        const { employeeId } = req.params;
        const snapshot = await db.collection('tot_regular_customers')
            .where('employeeId', '==', employeeId)
            .get();

        const list = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.json({ success: true, customers: list });
    } catch (error) {
        console.error('Error getting regular customers:', error);
        res.status(500).json({ success: false, message: 'Failed to retrieve customers' });
    }
});

app.post('/api/employee/regular-customers/:id/complete', async (req, res) => {
    try {
        const { id } = req.params;
        const todayStr = new Date().toISOString().split('T')[0];
        
        await db.collection('tot_regular_customers').doc(id).update({
            lastCompletedDate: todayStr
        });
        
        const doc = await db.collection('tot_regular_customers').doc(id).get();
        const customerData = doc.data();
        
        const completionRecord = {
            customerId: id,
            name: customerData.name,
            phone: customerData.phone,
            location: customerData.location,
            employeeId: customerData.employeeId,
            completedAt: new Date().toISOString(),
            date: todayStr,
            type: 'regular_visit'
        };
        
        await db.collection('tot_regular_completions').add(completionRecord);
        res.json({ success: true, message: 'Customer marked completed' });
    } catch (error) {
        console.error('Error completing customer:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/employee/regular-completions/:employeeId', async (req, res) => {
    try {
        const { employeeId } = req.params;
        const snapshot = await db.collection('tot_regular_completions')
            .where('employeeId', '==', employeeId)
            .get();
            
        const list = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        
        res.json({ success: true, completions: list });
    } catch (error) {
        console.error('Error fetching completions:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get employee stats (mock implementation)
// Get employee stats (Production Live Implementation)
app.get('/api/employee/stats/:empId', async (req, res) => {
    try {
        const { empId } = req.params;

        // 1. Fetch employee from DynamoDB
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: 'empId = :empId',
            ExpressionAttributeValues: { ':empId': empId }
        }));

        if (!result.Items || result.Items.length === 0) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }

        const employee = result.Items[0];
        const workHistory = employee.workHistory || {};

        // 2. Gather active rider session if online
        let activeSales = 0;
        let activeSalesAmount = 0;
        let activeRider = null;
        for (const [_, rider] of onlineRiders.entries()) {
            if (rider.employeeId === empId) {
                activeRider = rider;
                activeSales = rider.totalTeasSold || 0;
                activeSalesAmount = rider.totalSalesAmount || 0;
                break;
            }
        }

        // 3. Compute week/month date boundaries
        const now = new Date();
        
        // Sunday of this week
        const startOfWeek = new Date();
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);

        // 1st of this month
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        let todayOrders = activeRider ? 1 : 0; // count active shift as today's order/attendance
        let todayEarnings = 0;
        let todayTeas = activeSales;

        let weeklyOrders = todayOrders;
        let weeklyEarnings = 0;
        let weeklyTeas = todayTeas;

        let monthlyOrders = todayOrders;
        let monthlyEarnings = 0;
        let monthlyTeas = todayTeas;

        // 4. Aggregate past records from DynamoDB workHistory
        Object.keys(workHistory).forEach(dateStr => {
            const log = workHistory[dateStr];
            const dateObj = new Date(dateStr);
            const sales = parseInt(log.sales || 0, 10);
            
            // Check today
            const todayStr = now.toISOString().split('T')[0];
            if (dateStr === todayStr) {
                todayOrders = 1;
                todayTeas = sales;
            }

            // Check week
            if (dateObj >= startOfWeek) {
                if (dateStr !== todayStr) {
                    weeklyOrders++;
                    weeklyTeas += sales;
                }
            }

            // Check month
            if (dateObj >= startOfMonth) {
                if (dateStr !== todayStr) {
                    monthlyOrders++;
                    monthlyTeas += sales;
                }
            }
        });

        // 5. Calculate earnings based on daily commission rules (resets every shift/day)
        const getEarningForAmount = (amount) => {
            const amt = parseFloat(amount || 0);
            return amt < 3500 ? amt * 0.25 : amt * 0.30;
        };

        const todayStr = now.toISOString().split('T')[0];
        const todayLog = workHistory[todayStr];
        let todaySalesAmount = activeSalesAmount;

        if (todayLog) {
            todaySalesAmount = parseFloat(todayLog.salesAmount !== undefined ? todayLog.salesAmount : (todayLog.sales * 15));
        }
        todayEarnings = getEarningForAmount(todaySalesAmount);

        // Weekly and Monthly earnings are the sum of daily earnings
        weeklyEarnings = todayEarnings;
        monthlyEarnings = todayEarnings;

        Object.keys(workHistory).forEach(dateStr => {
            if (dateStr === todayStr) return; // already counted in todayEarnings
            const log = workHistory[dateStr];
            const dateObj = new Date(dateStr);
            const sales = parseInt(log.sales || 0, 10);
            const salesAmt = parseFloat(log.salesAmount !== undefined ? log.salesAmount : (sales * 15));
            const dayEarning = getEarningForAmount(salesAmt);

            if (dateObj >= startOfWeek) {
                weeklyEarnings += dayEarning;
            }
            if (dateObj >= startOfMonth) {
                monthlyEarnings += dayEarning;
            }
        });

        res.json({
            success: true,
            stats: {
                todayOrders,
                todayEarnings,
                weeklyOrders,
                weeklyEarnings,
                monthlyOrders,
                monthlyEarnings,
                rating: 4.8
            }
        });
    } catch (err) {
        console.error('Fetch Stats Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// --- Dispatch Operations Manual entry endpoints ---

// Get all manual dispatch entries
app.get('/api/admin/dispatches', async (req, res) => {
    try {
        const dispatchesCol = db.collection('tot_dispatches');
        const snapshot = await dispatchesCol.orderBy('createdAt', 'desc').get();
        const dispatches = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ success: true, data: dispatches });
    } catch (err) {
        console.error('Fetch Dispatches Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Create a new dispatch entry
app.post('/api/admin/dispatches', async (req, res) => {
    try {
        const dispatchData = {
            lot: req.body.lot || '1',
            date: req.body.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
            riderName: req.body.riderName || '',
            riderPhone: req.body.riderPhone || '',
            outTime: req.body.outTime || '',
            inTime: req.body.inTime || '',
            litersCount: req.body.litersCount || '',
            cupsOut: req.body.cupsOut || '',
            cupsIn: req.body.cupsIn || '',
            paymentOnline: req.body.paymentOnline || '',
            paymentCash: req.body.paymentCash || '',
            free: req.body.free || '',
            pending: req.body.pending || '',
            totalPayment: req.body.totalPayment || '',
            progress: req.body.progress || 'Not Completed',
            createdAt: new Date().toISOString()
        };
        const dispatchesCol = db.collection('tot_dispatches');
        const docRef = await dispatchesCol.add(dispatchData);
        res.json({ success: true, data: { id: docRef.id, ...dispatchData } });
    } catch (err) {
        console.error('Create Dispatch Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Update a dispatch entry (e.g. toggle progress or edit fields)
app.patch('/api/admin/dispatches/:id', async (req, res) => {
    try {
        const dispatchesCol = db.collection('tot_dispatches');
        await dispatchesCol.doc(req.params.id).update(req.body);
        res.json({ success: true, message: 'Dispatch updated successfully' });
    } catch (err) {
        console.error('Update Dispatch Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Delete a dispatch entry
app.delete('/api/admin/dispatches/:id', async (req, res) => {
    try {
        const dispatchesCol = db.collection('tot_dispatches');
        await dispatchesCol.doc(req.params.id).delete();
        res.json({ success: true, message: 'Dispatch deleted successfully' });
    } catch (err) {
        console.error('Delete Dispatch Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// --- Admin Routes ---

// Get all orders (for admin panel, with pagination and filtering)
app.get('/api/admin/orders', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const statusFilter = req.query.status || '';
        const paymentFilter = req.query.paymentMode || '';
        const employeePhoneFilter = req.query.employeePhone || '';
        const startDate = req.query.startDate || '';
        const endDate = req.query.endDate || '';
        const search = (req.query.search || '').toLowerCase();
        const isCorporate = req.query.isCorporate === 'true';

        // Fetch all orders from Firestore sorted by createdAt desc
        const snapshot = await ordersCol.orderBy('createdAt', 'desc').get();
        const allOrders = snapshot.docs.map(doc => doc.data());

        // Compute base non-pending orders
        const nonPendingOrders = allOrders.filter(o => o.status !== 'pending_payment');

        // Filter orders based on query parameters
        let filteredOrders = nonPendingOrders;

        // Apply Corporate filter (bulk and flask tea orders)
        if (isCorporate) {
            filteredOrders = filteredOrders.filter(o => {
                const isBulkType = o.isBulk === true || o.orderType === 'bulk';
                const isFlaskType = o.orderType === 'flask_tea' || o.items?.some(item => (item.name || '').toLowerCase().includes('flask tea'));
                return isBulkType || isFlaskType;
            });
        }

        // 1. Status Filter
        if (statusFilter) {
            filteredOrders = filteredOrders.filter(o => o.status === statusFilter);
        }

        // 2. Payment Mode Filter
        if (paymentFilter) {
            filteredOrders = filteredOrders.filter(o => {
                const mode = (o.paymentMode || '').toLowerCase();
                const filter = paymentFilter.toLowerCase();
                const isOffline = !!o.isOfflineSale;
                
                if (filter === 'cod') {
                    return !isOffline && (mode === 'cod' || mode === 'cash');
                }
                if (filter === 'cash') {
                    return isOffline && (mode === 'cod' || mode === 'cash');
                }
                if (filter === 'qr') {
                    return isOffline && (mode === 'online' || mode === 'upi');
                }
                if (filter === 'online') {
                    return !isOffline && (mode === 'online' || mode === 'upi');
                }
                return mode === filter;
            });
        }

        // 3. Employee Filter
        if (employeePhoneFilter) {
            filteredOrders = filteredOrders.filter(o => (o.employeePhone || '') === employeePhoneFilter);
        }

        // 4. Date range filter in IST
        if (startDate || endDate) {
            const getISTDateString = (dateInput) => {
                if (!dateInput) return '';
                try {
                    const d = new Date(dateInput);
                    if (isNaN(d.getTime())) return '';
                    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
                    return formatter.format(d);
                } catch (e) {
                    return '';
                }
            };

            filteredOrders = filteredOrders.filter(o => {
                const istDate = getISTDateString(o.createdAt);
                if (!istDate) return false;
                if (startDate && istDate < startDate) return false;
                if (endDate && istDate > endDate) return false;
                return true;
            });
        }

        // 4. Search Filter
        if (search) {
            filteredOrders = filteredOrders.filter(o => {
                return (o.id || '').toLowerCase().includes(search) ||
                       (o.customerName || '').toLowerCase().includes(search) ||
                       (o.customerPhone || '').includes(search) ||
                       (o.employeeName || '').toLowerCase().includes(search) ||
                       (o.employeePhone || '').includes(search);
            });
        }

        // Compute summary stats over the filtered subset of orders
        const totalOrders = filteredOrders.length;
        const activeOrders = filteredOrders.filter(o => ['placed', 'accepted', 'preparing', 'on_the_way', 'confirmed'].includes(o.status)).length;
        const totalRevenue = filteredOrders
            .filter(o => o.status === 'delivered')
            .reduce((sum, o) => sum + (parseFloat(o.totalAmount) || 0), 0);

        // Paginated slice
        const totalFiltered = filteredOrders.length;
        const totalPages = Math.ceil(totalFiltered / limit);
        const startIndex = (page - 1) * limit;
        const paginatedOrders = filteredOrders.slice(startIndex, startIndex + limit);

        res.json({
            success: true,
            page,
            limit,
            totalFiltered,
            totalPages,
            summary: {
                totalOrders,
                activeOrders,
                totalRevenue: Math.round(totalRevenue)
            },
            data: paginatedOrders
        });
    } catch (err) {
        console.error('Fetch Admin Orders Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch orders' });
    }
});

// Get order location analytics data (for Sales Analytics map)
app.get('/api/admin/orders/analytics-data', async (req, res) => {
    try {
        const limitVal = parseInt(req.query.limit) || 1000;
        const { startDate, endDate } = req.query;
        
        let query = ordersCol.orderBy('createdAt', 'desc');
        
        if (startDate) {
            query = query.where('createdAt', '>=', `${startDate}T00:00:00.000Z`);
        }
        if (endDate) {
            query = query.where('createdAt', '<=', `${endDate}T23:59:59.999Z`);
        }

        const snapshot = await query.limit(limitVal).get();
        const orders = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: data.id,
                lat: parseFloat(data.customerLocation?.latitude),
                lng: parseFloat(data.customerLocation?.longitude),
                status: data.status,
                refundStatus: data.refundStatus,
                totalAmount: parseFloat(data.totalAmount) || 0,
                createdAt: data.createdAt
            };
        }).filter(o => !isNaN(o.lat) && !isNaN(o.lng));

        res.json({
            success: true,
            count: orders.length,
            data: orders
        });
    } catch (err) {
        console.error('Fetch Orders Analytics Error (Attempting self-healing fallback):', err);
        try {
            const limitVal = parseInt(req.query.limit) || 1000;
            const snapshot = await ordersCol.orderBy('createdAt', 'desc').limit(limitVal).get();
            let orders = snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: data.id,
                    lat: parseFloat(data.customerLocation?.latitude),
                    lng: parseFloat(data.customerLocation?.longitude),
                    status: data.status,
                    refundStatus: data.refundStatus,
                    totalAmount: parseFloat(data.totalAmount) || 0,
                    createdAt: data.createdAt
                };
            }).filter(o => !isNaN(o.lat) && !isNaN(o.lng));

            if (req.query.startDate) {
                orders = orders.filter(o => o.createdAt >= `${req.query.startDate}T00:00:00.000Z`);
            }
            if (req.query.endDate) {
                orders = orders.filter(o => o.createdAt <= `${req.query.endDate}T23:59:59.999Z`);
            }

            res.json({
                success: true,
                count: orders.length,
                data: orders,
                fallbackFiltered: true
            });
        } catch (fallbackErr) {
            console.error('Fetch Orders Analytics Fallback Error:', fallbackErr);
            res.status(500).json({ success: false, message: 'Failed to fetch analytics data' });
        }
    }
});

// Get all users (customers) with pagination support to bypass the 1MB DynamoDB limit
app.get('/api/admin/users', async (req, res) => {
    try {
        const now = Date.now();
        if (adminUsersCache && (now - adminUsersCacheTime < ADMIN_USERS_CACHE_TTL)) {
            return res.json({ success: true, count: adminUsersCache.length, data: adminUsersCache });
        }

        if (!adminUsersFetchPromise) {
            adminUsersFetchPromise = (async () => {
                try {
                    let allItems = [];
                    let lastEvaluatedKey = undefined;

                    do {
                        const params = {
                            TableName: tableName,
                            FilterExpression: '#role = :role',
                            ExpressionAttributeNames: {
                                '#role': 'role'
                            },
                            ExpressionAttributeValues: {
                                ':role': 'customer'
                            }
                        };

                        if (lastEvaluatedKey) {
                            params.ExclusiveStartKey = lastEvaluatedKey;
                        }

                        const result = await ddbDocClient.send(new ScanCommand(params));
                        if (result.Items) {
                            allItems = allItems.concat(result.Items);
                        }
                        lastEvaluatedKey = result.LastEvaluatedKey;

                        if (lastEvaluatedKey) {
                            // Delay 150ms between pages to respect low provisioned RCUs (5 RCUs)
                            await new Promise(resolve => setTimeout(resolve, 150));
                        }
                    } while (lastEvaluatedKey);

                    adminUsersCache = allItems;
                    adminUsersCacheTime = Date.now();
                    return allItems;
                } finally {
                    adminUsersFetchPromise = null;
                }
            })();
        }

        const data = await adminUsersFetchPromise;
        res.json({ success: true, count: data.length, data: data });
    } catch (err) {
        console.error('Fetch Users Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch users' });
    }
});

// ==================== OFFICE EMPLOYEES ENDPOINTS ====================

// Register Office Employee (w/ optional AWS Rekognition Face Indexing)
app.post('/api/admin/office-employees', upload.fields([
    { name: 'photo', maxCount: 1 }
]), async (req, res) => {
    try {
        const { name, phone, employeeCode, role, shiftFrom, shiftTo, faceRegister } = req.body;
        const files = req.files;

        if (!name || !phone || !employeeCode || !role || !shiftFrom || !shiftTo) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        const photoUrl = (files && files.photo) ? files.photo[0].location : null;
        let faceRegistered = false;
        let faceId = null;

        // AWS Rekognition Face Registration Option
        if (faceRegister === 'true' && photoUrl && files && files.photo) {
            try {
                const { RekognitionClient, IndexFacesCommand, CreateCollectionCommand } = require('@aws-sdk/client-rekognition');
                const { bucketName } = require('./config/awsConfig');
                
                const rekognitionClient = new RekognitionClient({
                    region: process.env.AWS_REGION || 'ap-south-1',
                    credentials: {
                        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                    }
                });

                const s3Key = files.photo[0].key;
                const collectionId = 'office_employees_collection';

                console.log(`🤖 [Rekognition] Indexing face for S3 Key: ${s3Key} in bucket: ${bucketName}...`);

                let indexResponse;
                try {
                    indexResponse = await rekognitionClient.send(new IndexFacesCommand({
                        CollectionId: collectionId,
                        Image: {
                            S3Object: {
                                Bucket: bucketName,
                                Name: s3Key
                            }
                        },
                        ExternalImageId: employeeCode.replace(/[^a-zA-Z0-9_.\-:]/g, '_'), // AWS ExternalImageId validation sanitization
                        DetectionAttributes: ['DEFAULT']
                    }));
                } catch (idxErr) {
                    if (idxErr.name === 'ResourceNotFoundException') {
                        console.log(`🔍 [Rekognition] Collection '${collectionId}' not found. Creating it...`);
                        await rekognitionClient.send(new CreateCollectionCommand({
                            CollectionId: collectionId
                        }));
                        console.log(`✅ [Rekognition] Collection '${collectionId}' created successfully.`);
                        // Retry indexing
                        indexResponse = await rekognitionClient.send(new IndexFacesCommand({
                            CollectionId: collectionId,
                            Image: {
                                S3Object: {
                                    Bucket: bucketName,
                                    Name: s3Key
                                }
                            },
                            ExternalImageId: employeeCode.replace(/[^a-zA-Z0-9_.\-:]/g, '_'),
                            DetectionAttributes: ['DEFAULT']
                        }));
                    } else {
                        throw idxErr;
                    }
                }

                if (indexResponse && indexResponse.FaceRecords && indexResponse.FaceRecords.length > 0) {
                    faceRegistered = true;
                    faceId = indexResponse.FaceRecords[0].Face.FaceId;
                    console.log(`✅ [Rekognition] Face indexed successfully! FaceId: ${faceId}`);
                } else {
                    console.log(`⚠️ [Rekognition] No face detected in the uploaded image.`);
                }
            } catch (rekogErr) {
                console.error(`❌ [Rekognition Error] Face registration failed:`, rekogErr.message);
                // Fallback: set faceRegistered to false but proceed with registering the employee in DB
                faceRegistered = false;
            }
        }

        const employeeData = {
            id: employeeCode,
            name,
            phone,
            employeeCode,
            role,
            shiftFrom,
            shiftTo,
            photoUrl,
            faceRegistered,
            faceId,
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await db.collection('office_employees').doc(employeeCode).set(employeeData);

        res.json({ success: true, message: 'Office Employee registered successfully', data: employeeData });
    } catch (err) {
        console.error('Office Employee Registration Error:', err);
        res.status(500).json({ success: false, message: 'Failed to register office employee' });
    }
});

// Fetch all Office Employees
app.get('/api/admin/office-employees', async (req, res) => {
    try {
        const snapshot = await db.collection('office_employees').get();
        const employees = [];
        snapshot.forEach(doc => {
            employees.push(doc.data());
        });
        res.json({ success: true, count: employees.length, data: employees });
    } catch (err) {
        console.error('Fetch Office Employees Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch office employees' });
    }
});

// Update Office Employee Status
app.patch('/api/admin/office-employees/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['active', 'suspended', 'offline', 'online'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        await db.collection('office_employees').doc(id).update({
            status,
            updatedAt: new Date().toISOString()
        });

        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (err) {
        console.error('Update Office Employee Status Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update status' });
    }
});

// Delete Office Employee
app.delete('/api/admin/office-employees/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        try {
            const doc = await db.collection('office_employees').doc(id).get();
            if (doc.exists) {
                const emp = doc.data();
                if (emp.faceRegistered && emp.faceId) {
                    const { RekognitionClient, DeleteFacesCommand } = require('@aws-sdk/client-rekognition');
                    const rekognitionClient = new RekognitionClient({
                        region: process.env.AWS_REGION || 'ap-south-1',
                        credentials: {
                            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                        }
                    });
                    await rekognitionClient.send(new DeleteFacesCommand({
                        CollectionId: 'office_employees_collection',
                        FaceIds: [emp.faceId]
                    }));
                    console.log(`✅ [Rekognition] Deleted face ID ${emp.faceId} from collection.`);
                }
            }
        } catch (rekogErr) {
            console.error('Error deleting face from Rekognition during employee deletion:', rekogErr.message);
        }

        await db.collection('office_employees').doc(id).delete();
        res.json({ success: true, message: 'Office Employee deleted successfully' });
    } catch (err) {
        console.error('Delete Office Employee Error:', err);
        res.status(500).json({ success: false, message: 'Failed to delete employee' });
    }
});

// Record Office Employee Attendance (Manual Override)
app.post('/api/admin/office-attendance', async (req, res) => {
    try {
        const { employeeCode, status, reason, date, localTime } = req.body;
        const todayStr = date || new Date().toISOString().split('T')[0];
        
        if (!employeeCode || !status) {
            return res.status(400).json({ success: false, message: 'employeeCode and status are required' });
        }

        const empDoc = await db.collection('office_employees').doc(employeeCode).get();
        if (!empDoc.exists) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        const emp = empDoc.data();

        const docRef = db.collection('office_attendance').doc(`${employeeCode}_${todayStr}`);
        const doc = await docRef.get();
        const existingData = doc.exists ? doc.data() : {};

        const now = new Date();
        const timeStr = localTime || now.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: 'Asia/Kolkata'
        });

        let checkInTime = existingData.checkInTime || '--';
        let checkOutTime = existingData.checkOutTime || '--';
        let finalStatus = status;

        if (status === 'Check Out') {
            checkOutTime = timeStr;
            finalStatus = existingData.status || 'On Time';
        } else if (status === 'On Time' || status === 'Late') {
            checkInTime = timeStr;
            finalStatus = status;
        } else if (status === 'Absent') {
            checkInTime = '--';
            checkOutTime = '--';
            finalStatus = 'Absent';
        }

        const attendanceData = {
            id: `${employeeCode}_${todayStr}`,
            employeeCode,
            name: emp.name,
            role: emp.role,
            date: todayStr,
            checkInTime,
            checkOutTime,
            status: finalStatus,
            reason: reason || existingData.reason || '',
            updatedAt: new Date().toISOString()
        };

        await docRef.set(attendanceData, { merge: true });
        res.json({ success: true, message: 'Attendance recorded successfully', data: attendanceData });
    } catch (err) {
        console.error('Office Attendance Record Error:', err);
        res.status(500).json({ success: false, message: 'Failed to record attendance' });
    }
});

// Fetch Office Attendance (Supports Today or Custom Date)
app.get('/api/admin/office-attendance/today', async (req, res) => {
    try {
        const dateStr = req.query.date || new Date().toISOString().split('T')[0];
        const snapshot = await db.collection('office_attendance').where('date', '==', dateStr).get();
        const attendance = {};
        snapshot.forEach(doc => {
            const data = doc.data();
            attendance[data.employeeCode] = data;
        });
        res.json({ success: true, date: dateStr, data: attendance });
    } catch (err) {
        console.error('Fetch Office Attendance Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch attendance' });
    }
});

// Record Biometric Face-Matching Check-In/Out
app.post('/api/admin/office-attendance/biometric', upload.fields([
    { name: 'photo', maxCount: 1 }
]), async (req, res) => {
    try {
        const { employeeCode, action, localTime } = req.body; // action: 'in' or 'out'
        const files = req.files;

        if (!employeeCode || !action) {
            return res.status(400).json({ success: false, message: 'employeeCode and action are required.' });
        }

        const photoUrl = (files && files.photo) ? files.photo[0].location : null;
        if (!photoUrl || !files || !files.photo) {
            return res.status(400).json({ success: false, message: 'Camera photo capture is required.' });
        }

        const empDoc = await db.collection('office_employees').doc(employeeCode).get();
        if (!empDoc.exists) {
            return res.status(404).json({ success: false, message: 'Employee not found.' });
        }
        const emp = empDoc.data();

        if (!emp.faceRegistered || !emp.faceId) {
            return res.status(400).json({ success: false, message: 'No registered face profile found for this employee. Please register employee face profile first.' });
        }

        // Perform AWS Rekognition Face Match search
        const { RekognitionClient, SearchFacesByImageCommand } = require('@aws-sdk/client-rekognition');
        const { bucketName } = require('./config/awsConfig');
        
        const rekognitionClient = new RekognitionClient({
            region: process.env.AWS_REGION || 'ap-south-1',
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
        });

        const s3Key = files.photo[0].key;
        const collectionId = 'office_employees_collection';

        console.log(`🤖 [Biometric API] Verification face matching for S3 Key: ${s3Key} in bucket: ${bucketName}...`);

        let searchResponse;
        try {
            searchResponse = await rekognitionClient.send(new SearchFacesByImageCommand({
                CollectionId: collectionId,
                Image: {
                    S3Object: {
                        Bucket: bucketName,
                        Name: s3Key
                    }
                },
                MaxFaces: 1,
                FaceMatchThreshold: 85
            }));
        } catch (searchErr) {
            console.error('Rekognition verification search error:', searchErr);
            return res.status(400).json({ success: false, message: 'Face verification failed: ' + searchErr.message });
        }

        let isMatch = false;
        let matchConfidence = 0;

        if (searchResponse && searchResponse.FaceMatches && searchResponse.FaceMatches.length > 0) {
            const match = searchResponse.FaceMatches[0];
            const matchedExternalId = match.Face.ExternalImageId;
            const sanitizedCode = employeeCode.replace(/[^a-zA-Z0-9_.\-:]/g, '_');
            
            // Check if matched external image ID matches the sanitized employee code, or if the face matches the stored face ID
            if (matchedExternalId === sanitizedCode || match.Face.FaceId === emp.faceId) {
                isMatch = true;
                matchConfidence = match.Similarity;
                console.log(`✅ [Biometric] Identity confirmed! Confidence similarity: ${matchConfidence}%`);
            }
        }

        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Face match verification failed. Captured face does not match the registered profile.' });
        }

        // Face confirmed! Record check in / check out
        const todayStr = new Date().toISOString().split('T')[0];
        
        // Let's get current Indian Standard Time (IST) or system local time for formatting
        const now = new Date();
        const timeStr = localTime || now.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: 'Asia/Kolkata'
        });

        const attendanceRef = db.collection('office_attendance').doc(`${employeeCode}_${todayStr}`);
        const attendanceDoc = await attendanceRef.get();

        let attendanceData = {};

        if (action === 'in') {
            // Determine status based on shiftFrom hour
            let status = 'On Time';
            try {
                const [shiftH, shiftM] = emp.shiftFrom.split(':').map(Number);
                const istDateStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
                const istDate = new Date(istDateStr);
                const currentH = istDate.getHours();
                const currentM = istDate.getMinutes();

                if (currentH > shiftH || (currentH === shiftH && currentM > shiftM + 15)) { // 15 mins grace period
                    status = 'Late';
                }
            } catch (err) {
                console.error('Shift parsed evaluation failed:', err);
            }

            attendanceData = {
                id: `${employeeCode}_${todayStr}`,
                employeeCode,
                name: emp.name,
                role: emp.role,
                date: todayStr,
                checkInTime: timeStr,
                status,
                reason: '',
                updatedAt: new Date().toISOString()
            };
        } else {
            // Sign Out
            const existingData = attendanceDoc.exists ? attendanceDoc.data() : {};
            attendanceData = {
                id: `${employeeCode}_${todayStr}`,
                employeeCode,
                name: emp.name,
                role: emp.role,
                date: todayStr,
                checkInTime: existingData.checkInTime || '--',
                checkOutTime: timeStr,
                status: existingData.status || 'On Time',
                reason: existingData.reason || '',
                updatedAt: new Date().toISOString()
            };
        }

        await attendanceRef.set(attendanceData, { merge: true });
        res.json({
            success: true,
            message: `Attendance ${action === 'in' ? 'Check-in' : 'Check-out'} recorded successfully.`,
            confidence: matchConfidence.toFixed(1),
            data: attendanceData
        });

    } catch (err) {
        console.error('Biometric Office Attendance Endpoint Error:', err);
        res.status(500).json({ success: false, message: 'Internal server error recording biometric check-in.' });
    }
});

// ==================== ORIGINAL EMPLOYEES ROUTES ====================

// Get active and suspended employees
app.get('/api/admin/employees/active', async (req, res) => {
    try {
        const now = Date.now();
        if (activeEmployeesCache && (now - activeEmployeesCacheTime < ACTIVE_EMPLOYEES_CACHE_TTL)) {
            return res.json({ success: true, count: activeEmployeesCache.length, data: activeEmployeesCache });
        }

        let allItems = [];
        let lastEvaluatedKey = undefined;

        do {
            const params = {
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
            };

            if (lastEvaluatedKey) {
                params.ExclusiveStartKey = lastEvaluatedKey;
            }

            const result = await ddbDocClient.send(new ScanCommand(params));
            if (result.Items) {
                allItems = allItems.concat(result.Items);
            }
            lastEvaluatedKey = result.LastEvaluatedKey;

            if (lastEvaluatedKey) {
                // Delay 150ms between pages to respect low provisioned RCUs (5 RCUs)
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        } while (lastEvaluatedKey);

        activeEmployeesCache = allItems;
        activeEmployeesCacheTime = Date.now();

        res.json({ success: true, count: allItems.length, data: allItems });
    } catch (err) {
        console.error('Fetch Active Employees Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch active employees' });
    }
});

// Get detailed employee history (DynamoDB details + Firestore orders)
app.get('/api/admin/employees/:phone/history', async (req, res) => {
    try {
        const { phone } = req.params;

        // 1. Fetch employee from DynamoDB
        const getParams = {
            TableName: tableName,
            Key: { phone }
        };
        const empResult = await ddbDocClient.send(new GetCommand(getParams));
        if (!empResult.Item) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
        const employee = empResult.Item;

        // 2. Fetch all orders for this employee from Firestore tot_orders
        const empId = employee.empId || '';
        
        const [ordersSnapshotByPhone, ordersSnapshotById] = await Promise.all([
            ordersCol.where('employeePhone', '==', phone).get(),
            empId ? ordersCol.where('employeeId', '==', empId).get() : Promise.resolve({ docs: [] })
        ]);

        const ordersMap = new Map();
        ordersSnapshotByPhone.docs.forEach(doc => {
            const data = doc.data();
            ordersMap.set(data.id, data);
        });
        ordersSnapshotById.docs.forEach(doc => {
            const data = doc.data();
            ordersMap.set(data.id, data);
        });

        const orders = Array.from(ordersMap.values()).sort((a, b) => {
            return new Date(b.createdAt) - new Date(a.createdAt);
        });

        // 3. Reconcile with active/online rider session if they are currently online
        let activeRider = null;
        for (const [_, rider] of onlineRiders.entries()) {
            if (rider.employeePhone === phone || (empId && rider.employeeId === empId)) {
                activeRider = rider;
                break;
            }
        }

        if (!activeRider && empId) {
            try {
                const onlineDoc = await db.collection('online_riders').doc(empId).get();
                if (onlineDoc.exists) {
                    const rData = onlineDoc.data();
                    if (rData.isOnline) {
                        activeRider = rData;
                    }
                }
            } catch (err) {
                console.error('Error fetching online_riders document:', err);
            }
        }

        if (activeRider) {
            const todayStr = new Date().toISOString().split('T')[0];
            if (!employee.workHistory) {
                employee.workHistory = {};
            }
            const existingLog = employee.workHistory[todayStr] || {};
            const startMs = existingLog.startMs || (activeRider.onlineSince ? new Date(activeRider.onlineSince).getTime() : Date.now());
            const diffMs = Date.now() - startMs;
            const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
            const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

            employee.workHistory[todayStr] = {
                ...existingLog,
                sales: Math.max(existingLog.sales || 0, activeRider.totalTeasSold || 0, activeRider.teasSold || 0),
                duration: `${diffHrs}h ${diffMins}m`,
                durationMs: diffMs,
                canHistory: activeRider.canHistory || existingLog.canHistory || [],
                onduty: existingLog.onduty || (activeRider.onlineSince ? new Date(activeRider.onlineSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--'),
                offline: '—',
                startMs
            };
        }

        res.json({
            success: true,
            employee,
            orders
        });
    } catch (err) {
        console.error('Fetch Employee History Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch employee history' });
    }
});

// Get pending employee applications
app.get('/api/admin/applications/pending', async (req, res) => {
    try {
        let allItems = [];
        let lastEvaluatedKey = undefined;

        do {
            const params = {
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
            };

            if (lastEvaluatedKey) {
                params.ExclusiveStartKey = lastEvaluatedKey;
            }

            const result = await ddbDocClient.send(new ScanCommand(params));
            if (result.Items) {
                allItems = allItems.concat(result.Items);
            }
            lastEvaluatedKey = result.LastEvaluatedKey;

            if (lastEvaluatedKey) {
                // Delay 150ms between pages to respect low provisioned RCUs (5 RCUs)
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        } while (lastEvaluatedKey);

        res.json({ success: true, count: allItems.length, data: allItems });
    } catch (err) {
        console.error('Fetch Applications Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch applications' });
    }
});

// Approve, reject or suspend employee application
app.post('/api/admin/applications/:phone/status', async (req, res) => {
    try {
        const { phone } = req.params;
        const { status, reason } = req.body;

        if (!['active', 'rejected', 'suspended'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status. Must be active, rejected, or suspended' });
        }

        const ExpressionAttributeNames = { '#status': 'status' };
        const ExpressionAttributeValues = {
            ':status': status,
            ':time': new Date().toISOString()
        };
        let UpdateExpression = 'set #status = :status, updatedAt = :time';

        if (status === 'rejected') {
            UpdateExpression += ', rejectionReason = :reason';
            ExpressionAttributeValues[':reason'] = reason || 'No reason specified';
        } else if (status === 'active') {
            UpdateExpression += ', rejectionReason = :reason';
            ExpressionAttributeValues[':reason'] = '';
        }

        const updateParams = {
            TableName: tableName,
            Key: { phone },
            UpdateExpression,
            ExpressionAttributeNames,
            ExpressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };

        const result = await ddbDocClient.send(new UpdateCommand(updateParams));

        clearActiveEmployeesCache();

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

        clearActiveEmployeesCache();

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

// Rider checks their current prepared can status
app.get('/api/employees/:phone/can-status', async (req, res) => {
    try {
        let { phone } = req.params;
        if (phone && phone.startsWith(' ')) {
            phone = '+' + phone.trim();
        }
        let riderStatus = null;
        for (const [_, rider] of onlineRiders.entries()) {
            if (rider.employeePhone === phone) {
                riderStatus = {
                    canRequestStatus: rider.canRequestStatus || 'none',
                    preparedCanId: rider.preparedCanId || null,
                    canHistory: rider.canHistory || [],
                    flasks: rider.flasks || [],
                    activeFlaskIndex: rider.activeFlaskIndex !== undefined ? rider.activeFlaskIndex : -1,
                    totalSalesAmount: rider.totalSalesAmount || 0,
                    teaCups: rider.teaCups !== undefined ? rider.teaCups : 4500,
                    teasSold: rider.teasSold || 0,
                    totalTeasSold: rider.totalTeasSold || 0,
                    boxNumber: rider.boxNumber || 'Flask',
                    currentCan: rider.currentCan || '',
                    canIndex: rider.canIndex || 1,
                    isShiftActive: rider.isShiftActive || false
                };
                break;
            }
        }
        
        if (!riderStatus) {
            const snapshot = await db.collection('online_riders').where('employeePhone', '==', phone).get();
            if (!snapshot.empty) {
                const rData = snapshot.docs[0].data();
                riderStatus = {
                    canRequestStatus: rData.canRequestStatus || 'none',
                    preparedCanId: rData.preparedCanId || null,
                    canHistory: rData.canHistory || [],
                    flasks: rData.flasks || [],
                    activeFlaskIndex: rData.activeFlaskIndex !== undefined ? rData.activeFlaskIndex : -1,
                    totalSalesAmount: rData.totalSalesAmount || 0,
                    teaCups: rData.teaCups !== undefined ? rData.teaCups : 4500,
                    teasSold: rData.teasSold || 0,
                    totalTeasSold: rData.totalTeasSold || 0,
                    boxNumber: rData.boxNumber || 'Flask',
                    currentCan: rData.currentCan || '',
                    canIndex: rData.canIndex || 1,
                    isShiftActive: rData.isShiftActive || false
                };
            }
        }

        if (riderStatus) {
            res.json({ success: true, ...riderStatus });
        } else {
            res.status(404).json({ success: false, message: 'Rider session not found' });
        }
    } catch (err) {
        console.error('Fetch Can Status Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Update rider shift status (start/end shift)
app.patch('/api/employees/:phone/shift', async (req, res) => {
    try {
        let { phone } = req.params;
        if (phone && phone.startsWith(' ')) {
            phone = '+' + phone.trim();
        }
        const { isShiftActive } = req.body;
        
        const snapshot = await db.collection('online_riders').where('employeePhone', '==', phone).get();
        if (!snapshot.empty) {
            const docId = snapshot.docs[0].id;
            await db.collection('online_riders').doc(docId).update({
                isShiftActive: !!isShiftActive,
                lastUpdated: new Date().toISOString()
            });
            return res.json({ success: true, message: 'Shift status updated' });
        } else {
            const result = await ddbDocClient.send(new ScanCommand({
                TableName: tableName,
                FilterExpression: 'phone = :phone OR mobile = :phone',
                ExpressionAttributeValues: { ':phone': phone }
            }));
            
            if (result.Items && result.Items.length > 0) {
                const emp = result.Items[0];
                await db.collection('online_riders').doc(emp.empId).set({
                    employeeId: emp.empId,
                    employeeName: emp.name,
                    employeePhone: phone,
                    isShiftActive: !!isShiftActive,
                    isOnline: false,
                    lastUpdated: new Date().toISOString()
                }, { merge: true });
                return res.json({ success: true, message: 'Shift status created' });
            }
        }
        res.status(404).json({ success: false, message: 'Employee not found' });
    } catch (err) {
        console.error('Update Shift Status Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
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

        clearActiveEmployeesCache();

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

// App Version Config for Force Updates
app.get('/api/config/app-version', (req, res) => {
    res.json({
        minRequiredVersion: process.env.MIN_REQUIRED_VERSION || '0.0.1',
        latestVersion: process.env.LATEST_VERSION || '0.0.2',
        playStoreUrl: process.env.PLAY_STORE_URL || 'https://play.google.com/store/apps/details?id=com.thambiorutea2'
    });
});

// Get App Announcement Configuration
app.get('/api/config/announcement', async (req, res) => {
    try {
        const doc = await db.collection('settings').doc('app_announcement').get();
        if (doc.exists) {
            res.json({ success: true, data: doc.data() });
        } else {
            res.json({ success: true, data: { content: '', active: false } });
        }
    } catch (err) {
        console.error('Get Announcement Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch announcement config' });
    }
});

// Update App Announcement Configuration
app.post('/api/config/announcement', async (req, res) => {
    try {
        const { content, active } = req.body;
        const data = {
            content: content || '',
            active: !!active,
            updatedAt: new Date().toISOString()
        };
        await db.collection('settings').doc('app_announcement').set(data);
        res.json({ success: true, message: 'Announcement updated successfully', data });
    } catch (err) {
        console.error('Update Announcement Error:', err);
        res.status(500).json({ success: false, message: 'Failed to update announcement config' });
    }
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

// Global Express Error Handler
app.use((err, req, res, next) => {
    if (err.message === 'Request aborted') {
        console.warn(`⚠️ [Multer] Request aborted by client: ${req.method} ${req.path}`);
        return res.status(499).json({ success: false, message: 'Client closed connection before upload completed' });
    }
    console.error('❌ Express Error:', err.stack || err.message);
    res.status(500).json({ success: false, message: err.message || 'Internal Server Error' });
});

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

// ============================================
// AUTOMATED DAILY PUSH NOTIFICATION SCHEDULER
// Fires push alerts to 'all_users' (covering both thambiorutea2 and totemployee) in Indian Standard Time (IST)
// ============================================

const LAST_FIRED_FILE = path.join(__dirname, '.last_fired_time.json');

function getLastFiredTime() {
    try {
        if (fs.existsSync(LAST_FIRED_FILE)) {
            const data = fs.readFileSync(LAST_FIRED_FILE, 'utf8');
            return JSON.parse(data).lastFiredTime || '';
        }
    } catch (err) {
        console.error('Error reading last fired time file:', err);
    }
    return '';
}

function setLastFiredTime(timeStr) {
    try {
        fs.writeFileSync(LAST_FIRED_FILE, JSON.stringify({ lastFiredTime: timeStr }), 'utf8');
    } catch (err) {
        console.error('Error writing last fired time file:', err);
    }
}

async function sendScheduledPushNotification(title, body) {
    try {
        console.log(`⏰ [Scheduled Notification] Preparing automated push alert: "${title}"`);
        const message = {
            notification: {
                title: title,
                body: body
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
                }
            },
            data: {
                type: 'broadcast',
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                title: title,
                body: body
            }
        };

        const response = await admin.messaging().send(message);
        console.log(`✅ [Scheduled Notification] Sent successfully to topic "all_users":`, response);
    } catch (err) {
        console.error('❌ [Scheduled Notification] Failed to send broadcast:', err);
    }
}

function checkAndSendScheduledNotifications() {
    try {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        
        const parts = formatter.formatToParts(now);
        let year = '', month = '', day = '', hour = '', minute = '';
        for (const part of parts) {
            if (part.type === 'year') year = part.value;
            if (part.type === 'month') month = part.value;
            if (part.type === 'day') day = part.value;
            if (part.type === 'hour') hour = part.value;
            if (part.type === 'minute') minute = part.value;
        }
        
        const timeKey = `${hour}:${minute}`; // "HH:mm"
        const fireKey = `${year}-${month}-${day} ${timeKey}`; // "YYYY-MM-DD HH:mm"

        const schedules = {
            "07:00": {
                title: "காலை வணக்கம்! டீ ரெடி ☕",
                body: "உங்கள் நாளை ஒரு சூடான டீயுடன் தொடங்குங்கள். இப்போதே ஆர்டர் செய்து புத்துணர்ச்சி பெறுங்கள்."
            },
            "11:00": {
                title: "Tea Break Time! ☕✨",
                body: "வேலை அழுத்தத்தை மறந்து ஒரு சூடான டீயுடன் புத்துணர்ச்சி பெறுங்கள். இப்போதே ஆர்டர் செய்யுங்கள்."
            },
            "13:00": {
                title: "Lunch + Tea = Perfect Combo ☕🍽️",
                body: "மதிய உணவுக்குப் பிறகு ஒரு சூடான டீ உங்கள் மனதையும் உடலையும் ரிலாக்ஸ் செய்யும்."
            },
            "16:00": {
                title: "It's Tea O'Clock! ☕⏰",
                body: "மாலை நேர சோர்வை ஒரு கப் சூடான டீயால் விரட்டுங்கள். இப்போதே ஆர்டர் செய்யுங்கள்."
            },
            "18:00": {
                title: "Work Done? Tea Time! ☕🎉",
                body: "நாள் முழுவதும் உழைத்த பிறகு ஒரு சூடான டீயுடன் மாலையை மகிழ்ச்சியாக கழியுங்கள்."
            }
        };

        const lastFiredTime = getLastFiredTime();
        if (schedules[timeKey] && lastFiredTime !== fireKey) {
            setLastFiredTime(fireKey);
            const promo = schedules[timeKey];
            sendScheduledPushNotification(promo.title, promo.body);
        }
    } catch (err) {
        console.error('❌ [Scheduled Notification] Error in check logic:', err);
    }
}

// Start checking every 10 seconds to ensure high accuracy without missing or double firing
setInterval(checkAndSendScheduledNotifications, 10000);

