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
        const phone = '6383190842';
        
        // 1. Fetch employee from DynamoDB
        const getParams = {
            TableName: tableName,
            Key: { phone }
        };
        const empResult = await ddbDocClient.send(new GetCommand(getParams));
        const employee = empResult.Item;
        if (!employee) {
            console.log('Employee not found');
            process.exit(1);
        }
        console.log('Employee found:', employee.name);

        const empId = employee.empId || '';
        
        console.log('Fetching orders...');
        const [ordersSnapshotByPhone, ordersSnapshotById] = await Promise.all([
            ordersCol.where('employeePhone', '==', phone).get(),
            empId ? ordersCol.where('employeeId', '==', empId).get() : Promise.resolve({ docs: [] })
        ]);

        console.log('Building orders list...');
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

        console.log(`Success! Total orders fetched: ${orders.length}`);
        process.exit(0);
    } catch (err) {
        console.error('Error occurred in endpoint logic:', err);
        process.exit(1);
    }
}

testHistory();
