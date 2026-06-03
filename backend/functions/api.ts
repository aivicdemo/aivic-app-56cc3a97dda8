import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, hasPermission, extractUserFromEvent } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createResponse(statusCode: number, body: any): ApiResponse {
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

function createErrorResponse(statusCode: number, message: string): ApiResponse {
  return createResponse(statusCode, { error: message });
}

async function createAuditLog(user: User, action: string, resource: string, details?: any): Promise<void> {
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: 'AUDIT',
        sk: `${Date.now()}_${randomUUID()}`,
        userId: user.id,
        userRole: user.role,
        action,
        resource,
        details,
        timestamp: new Date().toISOString()
      }
    }));
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

function validateUser(user: User | null): user is User {
  return user !== null;
}

function parseRequestBody(body: string | null): any {
  if (!body) throw new Error('Request body is required');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Invalid JSON in request body');
  }
}

async function handleGetResources(event: APIGatewayProxyEvent, user: User): Promise<ApiResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createErrorResponse(403, 'Insufficient permissions');
  }

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk <> :auditPk',
      ExpressionAttributeValues: {
        ':auditPk': 'AUDIT'
      }
    }));

    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error fetching resources:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}

async function handleBulkImport(event: APIGatewayProxyEvent, user: User, tableIndex: string): Promise<ApiResponse> {
  if (!hasPermission(user, 'resources', 'bulk')) {
    return createErrorResponse(403, 'Insufficient permissions for bulk operations');
  }

  try {
    const requestBody = parseRequestBody(event.body);
    const { items } = requestBody;

    if (!Array.isArray(items)) {
      return createErrorResponse(400, 'Items must be an array');
    }

    if (items.length === 0) {
      return createErrorResponse(400, 'Items array cannot be empty');
    }

    const now = new Date().toISOString();
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const putRequests = batch.map((item, index) => {
        const enrichedItem = {
          ...item,
          id: item.id || randomUUID(),
          pk: item.pk || `RESOURCE_${tableIndex}`,
          sk: item.sk || `${Date.now()}_${index}`,
          createdAt: now,
          updatedAt: now
        };

        return {
          PutRequest: {
            Item: enrichedItem
          }
        };
      });

      try {
        const batchResult = await docClient.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: putRequests
          }
        }));

        const unprocessedCount = batchResult.UnprocessedItems?.[TABLE_NAME]?.length || 0;
        imported += (batch.length - unprocessedCount);
        failed += unprocessedCount;

        if (unprocessedCount > 0) {
          errors.push(`Batch ${Math.floor(i / 25) + 1}: ${unprocessedCount} items failed to process`);
        }
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Create audit log
    await createAuditLog(user, 'BULK_IMPORT', `table_${tableIndex}`, {
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
    if (error instanceof Error && error.message.includes('required')) {
      return createErrorResponse(400, error.message);
    }
    return createErrorResponse(500, 'Internal server error');
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    // Extract and validate user
    const user = extractUserFromEvent(event);
    if (!validateUser(user)) {
      return createErrorResponse(401, 'Authentication required');
    }

    const { httpMethod, path } = event;
    const pathParts = path.split('/').filter(Boolean);

    // Route handling
    if (httpMethod === 'GET' && path === '/resources') {
      return await handleGetResources(event, user);
    }

    // Bulk import endpoint: POST /api/{tableIndex}/bulk
    if (httpMethod === 'POST' && pathParts.length === 3 && pathParts[0] === 'api' && pathParts[2] === 'bulk') {
      const tableIndex = pathParts[1];
      return await handleBulkImport(event, user, tableIndex);
    }

    return createErrorResponse(404, 'Endpoint not found');
  } catch (error) {
    console.error('Unhandled error:', error);
    return createErrorResponse(500, 'Internal server error');
  }
};