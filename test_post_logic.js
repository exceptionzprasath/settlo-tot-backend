const { initFirebase } = require('./config/firebaseAdmin');
const db = initFirebase();
const ordersCol = db.collection('tot_orders');
const admin = require('firebase-admin');

// Helper functions from server.js
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

async function testOrderRoute(reqBody) {
    try {
        const customerPhone = reqBody.customerPhone;
        console.log(`\nTesting with customerPhone: ${customerPhone}`);
        if (customerPhone) {
            const ordersSnapshot = await ordersCol
                .where('customerPhone', '==', customerPhone)
                .get();

            console.log(`Found ${ordersSnapshot.size} existing orders for ${customerPhone}`);

            const activeOrder = ordersSnapshot.docs.find(doc => {
                const data = doc.data();
                if (data.status === 'confirmed') {
                    return true;
                }
                if (data.status === 'placed') {
                    const elapsed = Date.now() - new Date(data.createdAt).getTime();
                    return elapsed < 300000;
                }
                return false;
            });

            if (activeOrder) {
                console.log('Active order block triggered! Order ID:', activeOrder.id);
                return;
            }
        }

        const orderId = reqBody.id || ('ORD' + Math.floor(100000 + Math.random() * 900000));

        let customerLocation = reqBody.customerLocation || null;
        if (!customerLocation && reqBody.locationCoords) {
            customerLocation = {
                latitude: reqBody.locationCoords.latitude,
                longitude: reqBody.locationCoords.longitude,
                address: reqBody.deliveryAddress || ''
            };
        }

        // Check first tea free eligibility
        const phone = reqBody.customerPhone;
        let isEligibleForFreeTea = false;
        let isSpinFreeTea = false;
        let ordersSnapshot;
        
        if (phone) {
            ordersSnapshot = await ordersCol.where('customerPhone', '==', phone).get();
            const validOrders = ordersSnapshot.docs.filter(doc => {
                const status = doc.data().status;
                return status === 'delivered' || status === 'placed' || status === 'confirmed';
            });
            
            const hasReceivedFirstFreeTea = validOrders.some(doc => doc.data().firstTeaFree === true && !doc.data().spinFreeTea);
            const isFirstTeaEligible = !hasReceivedFirstFreeTea;
            
            if (isFirstTeaEligible) {
                isEligibleForFreeTea = true;
            } else {
                const spinDoc = await db.collection('tot_spins').doc(phone).get();
                if (spinDoc.exists) {
                    const spinData = spinDoc.data();
                    const ist = getISTInfo(new Date());
                    
                    if (spinData.currentWeek === ist.weekIdentifier && spinData.currentWeekWinDay) {
                        const activeOrdersWithSpinTea = ordersSnapshot.docs.filter(doc => {
                            const data = doc.data();
                            const isActiveOrDelivered = data.status === 'delivered' || data.status === 'placed' || data.status === 'confirmed';
                            
                            // Let's print out what is passed to Date constructor
                            console.log(`Checking order ${doc.id} createdAt:`, data.createdAt);
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
        }

        let items = reqBody.items || [];
        const isBulk = reqBody.isBulk === true;
        let firstTeaFree = false;
        let finalTotalAmount = parseFloat(reqBody.totalAmount) || 0;

        if (isEligibleForFreeTea) {
            const teaItemIndex = items.findIndex(item => item.id === 'item_001');
            if (teaItemIndex > -1) {
                firstTeaFree = true;
                let calcTotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
                calcTotal = Math.max(0, calcTotal - 15);
                finalTotalAmount = calcTotal;
            }
        }

        const isFreeOrder = finalTotalAmount === 0;
        const paymentMethod = reqBody.paymentMethod || 'ONLINE';
        const hasFlaskTea = items.some(item => 
            (item.name || '').toLowerCase().includes('flask tea')
        );
        const isFlaskOrBulk = hasFlaskTea || isBulk;

        if (paymentMethod === 'COD' || isFreeOrder) {
            console.log('Processing as COD/Free Order...');
            const orderData = {
                ...reqBody,
                id: orderId,
                items,
                totalAmount: finalTotalAmount,
                customerLocation,
                status: reqBody.status || 'placed',
                paymentMode: isFreeOrder ? 'free' : (reqBody.paymentMode || 'COD'),
                paymentStatus: isFreeOrder ? 'paid' : (reqBody.paymentStatus || 'pending'),
                firstTeaFree,
                spinFreeTea: isSpinFreeTea,
                orderType: isFlaskOrBulk ? (isBulk ? 'bulk' : 'flask_tea') : 'normal',
                isBulk: isBulk,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            console.log('Writing order to Firestore directly...');
            await ordersCol.doc(orderId).set(orderData);
            console.log('Order written successfully!');
            return { success: true, orderId };
        } else {
            console.log('Processing as ONLINE Order...');
            // In test, skip Razorpay order creation to avoid calling live/test Razorpay API or check if it fails
            return { success: true, message: 'Skipped Razorpay path in test' };
        }

    } catch (err) {
        console.error('ERROR in testOrderRoute:', err);
    }
}

async function run() {
    // Test 1: Phone number with no previous orders/spins
    await testOrderRoute({
        customerPhone: '1111111111',
        paymentMethod: 'COD',
        items: [{ id: 'item_001', name: 'Premium Tea', price: 15, quantity: 1 }],
        totalAmount: 15
    });

    // Test 2: Let's fetch some existing users/orders to check if they fail
    // We can query a list of orders that have customerPhone set
    const recentOrders = await ordersCol.where('customerPhone', '!=', 'N/A').limit(5).get();
    console.log(`\nFound ${recentOrders.size} recent customer orders in db`);
    for (const doc of recentOrders.docs) {
        const phone = doc.data().customerPhone;
        if (phone) {
            await testOrderRoute({
                customerPhone: phone,
                paymentMethod: 'COD',
                items: [{ id: 'item_001', name: 'Premium Tea', price: 15, quantity: 1 }],
                totalAmount: 15
            });
        }
    }

    process.exit(0);
}

run();
