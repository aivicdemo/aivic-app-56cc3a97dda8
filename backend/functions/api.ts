import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, Role, hasPermission, extractUserFromEvent } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface ErrorResponse {
  error: string;
  message: string;
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

function createErrorResponse(statusCode: number, error: string, message: string): APIGatewayProxyResult {
  return createResponse(statusCode, { error, message });
}

async function createAuditLog(user: User, action: string, resource: string, details: any = {}): Promise<void> {
  try {
    const auditItem = {
      pk: 'AUDIT',
      sk: `${Date.now()}_${randomUUID()}`,
      userId: user.id,
      userRole: user.role,
      action,
      resource,
      details,
      timestamp: new Date().toISOString()
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditItem
    }));
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

async function getResources(user: User): Promise<APIGatewayProxyResult> {
  if (!hasPermission(user.role, 'resources', 'read')) {
    return createErrorResponse(403, 'Forbidden', 'Insufficient permissions');
  }

  try {
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': 'RESOURCE'
      }
    });

    const result = await docClient.send(command);
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to retrieve resources');
  }
}

async function bulkImportResources(user: User, items: Record<string, unknown>[]): Promise<APIGatewayProxyResult> {
  if (!hasPermission(user.role, 'resources', 'bulk')) {
    return createErrorResponse(403, 'Forbidden', 'Insufficient permissions for bulk operations');
  }

  if (!Array.isArray(items) || items.length === 0) {
    return createErrorResponse(400, 'BadRequest', 'Items array is required and must not be empty');
  }

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];
  const now = new Date().toISOString();

  try {
    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const putRequests = batch.map(item => {
        const processedItem = {
          ...item,
          pk: 'RESOURCE',
          sk: item.id || randomUUID(),
          id: item.id || randomUUID(),
          createdAt: now,
          updatedAt: now
        };

        return {
          PutRequest: {
            Item: processedItem
          }
        };
      });

      try {
        const command = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: putRequests
          }
        });

        const result = await docClient.send(command);
        
        // Handle unprocessed items
        if (result.UnprocessedItems && result.UnprocessedItems[TABLE_NAME]) {
          const unprocessedCount = result.UnprocessedItems[TABLE_NAME].length;
          failed += unprocessedCount;
          imported += (batch.length - unprocessedCount);
          errors.push(`${unprocessedCount} items failed to process in batch starting at index ${i}`);
        } else {
          imported += batch.length;
        }
      } catch (batchError) {
        failed += batch.length;
        errors.push(`Batch starting at index ${i} failed: ${batchError}`);
      }
    }

    // Create audit log
    await createAuditLog(user, 'BULK_IMPORT', 'resources', {
      totalItems: items.length,
      imported,
      failed
    });

    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return createErrorResponse(500, 'InternalServerError', 'Failed to perform bulk import');
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    // Extract user from event
    const user = extractUserFromEvent(event);
    if (!user) {
      return createErrorResponse(401, 'Unauthorized', 'Valid authentication required');
    }

    const path = event.path;
    const method = event.httpMethod;

    // Route handling
    if (method === 'GET' && path === '/resources') {
      return await getResources(user);
    }

    if (method === 'POST' && path === '/api/0/bulk') {
      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch {
        return createErrorResponse(400, 'BadRequest', 'Invalid JSON in request body');
      }

      if (!requestBody.items) {
        return createErrorResponse(400, 'BadRequest', 'Missing items array in request body');
      }

      return await bulkImportResources(user, requestBody.items);
    }

    return createErrorResponse(404, 'NotFound', 'Endpoint not found');
  } catch (error) {
    console.error('Unhandled error:', error);
    return createErrorResponse(500, 'InternalServerError', 'An unexpected error occurred');
  }
};