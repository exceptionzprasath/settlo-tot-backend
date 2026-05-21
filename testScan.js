const { ddbDocClient } = require('./config/awsConfig');
const { ScanCommand } = require('@aws-sdk/lib-dynamodb');

async function testScan() {
    try {
        const result = await ddbDocClient.send(new ScanCommand({
            TableName: 'tot_orders'
        }));
        console.log(JSON.stringify(result.Items, null, 2));
    } catch (e) {
        console.error(e);
    }
}
testScan();
