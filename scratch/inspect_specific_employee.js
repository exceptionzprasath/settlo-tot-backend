const { ddbDocClient, tableName } = require('../config/awsConfig');
const { GetCommand } = require('@aws-sdk/lib-dynamodb');

async function checkEmployee() {
    try {
        const phone = '6383190842';
        const getParams = {
            TableName: tableName,
            Key: { phone }
        };
        const empResult = await ddbDocClient.send(new GetCommand(getParams));
        if (empResult.Item) {
            console.log('Employee details:', JSON.stringify(empResult.Item, null, 2));
        } else {
            console.log(`Employee with phone ${phone} not found.`);
        }
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkEmployee();
