const { CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { CreateBucketCommand, PutBucketCorsCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { ddbDocClient, s3Client, tableName, ordersTable, bucketName } = require('../config/awsConfig');

async function setupDynamoDB() {
    // Setup Users Table
    console.log(`Checking DynamoDB table: ${tableName}...`);
    try {
        await ddbDocClient.send(new DescribeTableCommand({ TableName: tableName }));
        console.log(`Table ${tableName} already exists.`);
    } catch (err) {
        if (err.name === 'ResourceNotFoundException') {
            console.log(`Table ${tableName} not found. Creating...`);
            const params = {
                TableName: tableName,
                AttributeDefinitions: [
                    { AttributeName: 'phone', AttributeType: 'S' },
                ],
                KeySchema: [
                    { AttributeName: 'phone', KeyType: 'HASH' },
                ],
                ProvisionedThroughput: {
                    ReadCapacityUnits: 5,
                    WriteCapacityUnits: 5,
                },
            };
            await ddbDocClient.send(new CreateTableCommand(params));
            console.log(`Table ${tableName} created successfully.`);
        } else {
            console.error('Error checking/creating table:', err);
        }
    }

    // Setup Orders Table
    console.log(`Checking DynamoDB table: ${ordersTable}...`);
    try {
        await ddbDocClient.send(new DescribeTableCommand({ TableName: ordersTable }));
        console.log(`Table ${ordersTable} already exists.`);
    } catch (err) {
        if (err.name === 'ResourceNotFoundException') {
            console.log(`Table ${ordersTable} not found. Creating...`);
            const params = {
                TableName: ordersTable,
                AttributeDefinitions: [
                    { AttributeName: 'id', AttributeType: 'S' },
                ],
                KeySchema: [
                    { AttributeName: 'id', KeyType: 'HASH' },
                ],
                ProvisionedThroughput: {
                    ReadCapacityUnits: 5,
                    WriteCapacityUnits: 5,
                },
            };
            await ddbDocClient.send(new CreateTableCommand(params));
            console.log(`Table ${ordersTable} created successfully.`);
        } else {
            console.error('Error checking/creating orders table:', err);
        }
    }
}

async function setupS3() {
    console.log(`Checking S3 bucket: ${bucketName}...`);
    try {
        await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }));
        console.log(`Bucket ${bucketName} already exists.`);
    } catch (err) {
        console.log(`Bucket ${bucketName} not found. Creating...`);
        try {
            await s3Client.send(new CreateBucketCommand({ 
                Bucket: bucketName,
                // For ap-south-1, we need to specify LocationConstraint if not us-east-1
                CreateBucketConfiguration: {
                    LocationConstraint: 'ap-south-1'
                }
            }));
            console.log(`Bucket ${bucketName} created successfully.`);
        } catch (createErr) {
            console.error('Error creating bucket:', createErr);
            return;
        }
    }

    // Set CORS
    console.log(`Setting CORS for bucket: ${bucketName}...`);
    const corsParams = {
        Bucket: bucketName,
        CORSConfiguration: {
            CORSRules: [
                {
                    AllowedHeaders: ['*'],
                    AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
                    AllowedOrigins: ['*'],
                    ExposeHeaders: [],
                    MaxAgeSeconds: 3000,
                },
            ],
        },
    };
    try {
        await s3Client.send(new PutBucketCorsCommand(corsParams));
        console.log('CORS configuration updated.');
    } catch (err) {
        console.error('Error setting CORS:', err);
    }
}

async function runSetup() {
    await setupDynamoDB();
    await setupS3();
    console.log('AWS Setup completed.');
}

module.exports = { runSetup };
