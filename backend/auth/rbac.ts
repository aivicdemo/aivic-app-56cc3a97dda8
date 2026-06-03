export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  role: Role;
  email?: string;
}

export interface Permission {
  resource: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'bulk';
}

const rolePermissions: Record<Role, Permission[]> = {
  admin: [
    { resource: 'resources', action: 'create' },
    { resource: 'resources', action: 'read' },
    { resource: 'resources', action: 'update' },
    { resource: 'resources', action: 'delete' },
    { resource: 'resources', action: 'bulk' }
  ],
  operator: [
    { resource: 'resources', action: 'create' },
    { resource: 'resources', action: 'read' },
    { resource: 'resources', action: 'update' },
    { resource: 'resources', action: 'bulk' }
  ],
  viewer: [
    { resource: 'resources', action: 'read' }
  ]
};

export function hasPermission(role: Role, resource: string, action: string): boolean {
  const permissions = rolePermissions[role] || [];
  return permissions.some(p => p.resource === resource && p.action === action);
}

export function extractUserFromEvent(event: any): User | null {
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader) return null;
    
    const token = authHeader.replace('Bearer ', '');
    const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    
    return {
      id: decoded.sub || decoded.userId || 'unknown',
      role: decoded.role || 'viewer',
      email: decoded.email
    };
  } catch {
    return null;
  }
}