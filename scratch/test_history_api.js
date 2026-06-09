const admin = require('firebase-admin');
const serviceAccount = require('../foodman-1f911-firebase-adminsdk-fbsvc-6253adf187.json');
const { ddbDocClient, tableName } = require('../config/awsConfig');
const { GetCommand } = require('@aws-sdk/lib-dynamodb');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();
const ordersCol = db.collection('tot_orders');

async function testHistory() {
    try {
        const phone = '9361016097';
        
        // 1. Fetch employee from DynamoDB
        const getParams = {
            TableName: tableName,
            Key: { phone }
        };
        const empResult = await ddbDocClient.send(new GetCommand(getParams));
        const employee = empResult.Item;
        console.log('Employee found:', employee?.name);

        const empId = employee?.empId || '';
        
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

        console.log(`Total orders fetched: ${orders.length}`);
        
        // Search for the offline order
        const offlineOrder = orders.find(o => o.id.startsWith('OFF'));
        if (offlineOrder) {
            console.log('Found offline order in result:', JSON.stringify(offlineOrder, null, 2));
        } else {
            console.log('NO offline order starting with OFF found in the fetched list.');
        }

        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

testHistory();
