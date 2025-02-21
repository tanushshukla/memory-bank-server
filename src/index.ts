#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import storage from 'node-persist';
import path from 'path';
import os from 'os';

// Initialize storage in user's home directory
const STORAGE_PATH = path.join(os.homedir(), '.memory-bank');

// Validation constants
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_LENGTH = 1024 * 1024; // 1MB
const KEY_PATTERN = /^[a-zA-Z0-9-_:.]+$/;

interface StoredValue {
  value: string;
  timestamp: number;
  expiry?: number;
}

class MemoryBankServer {
  private server: Server;
  private initialized: boolean = false;

  constructor() {
    this.server = new Server(
      {
        name: 'memory-bank-server',
        version: '0.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private async ensureInitialized() {
    if (!this.initialized) {
      await storage.init({
        dir: STORAGE_PATH,
        stringify: JSON.stringify,
        parse: JSON.parse,
      });
      this.initialized = true;
    }
  }

  private validateKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Key must be a non-empty string');
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `Key length must not exceed ${MAX_KEY_LENGTH} characters`);
    }
    if (!KEY_PATTERN.test(key)) {
      throw new McpError(ErrorCode.InvalidParams, 'Key must contain only alphanumeric characters, hyphens, underscores, dots, and colons');
    }
  }

  private validateValue(value: string): void {
    if (typeof value !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Value must be a string');
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `Value length must not exceed ${MAX_VALUE_LENGTH} bytes`);
    }
  }

  private validateNamespace(namespace?: string): void {
    if (namespace !== undefined) {
      this.validateKey(namespace);
    }
  }

  private async cleanExpiredValues() {
    const keys = await storage.keys();
    const now = Date.now();
    
    for (const key of keys) {
      const data = await storage.getItem(key) as StoredValue;
      if (data && data.expiry && now > data.expiry) {
        await storage.removeItem(key);
      }
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'store',
          description: 'Store a value in memory bank',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Key to store the value under',
              },
              value: {
                type: 'string',
                description: 'Value to store',
              },
              namespace: {
                type: 'string',
                description: 'Optional namespace to organize values',
              },
              ttl: {
                type: 'number',
                description: 'Optional time-to-live in seconds',
              },
            },
            required: ['key', 'value'],
          },
        },
        {
          name: 'retrieve',
          description: 'Retrieve a value from memory bank',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Key to retrieve the value for',
              },
              namespace: {
                type: 'string',
                description: 'Optional namespace to retrieve from',
              },
            },
            required: ['key'],
          },
        },
        {
          name: 'list',
          description: 'List all stored keys in a namespace',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'Optional namespace to list keys from',
              },
              includeMetadata: {
                type: 'boolean',
                description: 'Include timestamps and expiry info',
              },
            },
          },
        },
        {
          name: 'delete',
          description: 'Delete a stored value',
          inputSchema: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Key to delete',
              },
              namespace: {
                type: 'string',
                description: 'Optional namespace',
              },
            },
            required: ['key'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      await this.ensureInitialized();
      await this.cleanExpiredValues();

      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'store': {
            const { key, value, namespace, ttl } = args as { 
              key: string; 
              value: string; 
              namespace?: string; 
              ttl?: number;
            };

            this.validateKey(key);
            this.validateValue(value);
            this.validateNamespace(namespace);

            const storageKey = namespace ? `${namespace}:${key}` : key;
            const storedValue: StoredValue = {
              value,
              timestamp: Date.now(),
              ...(ttl && { expiry: Date.now() + (ttl * 1000) }),
            };

            await storage.setItem(storageKey, storedValue);
            return {
              content: [{ type: 'text', text: `Successfully stored value for key: ${key}` }],
            };
          }

          case 'retrieve': {
            const { key, namespace } = args as { key: string; namespace?: string };
            
            this.validateKey(key);
            this.validateNamespace(namespace);

            const storageKey = namespace ? `${namespace}:${key}` : key;
            const data = await storage.getItem(storageKey) as StoredValue;

            if (!data || (data.expiry && Date.now() > data.expiry)) {
              throw new McpError(ErrorCode.InvalidRequest, `No value found for key: ${key}`);
            }

            return {
              content: [{ type: 'text', text: data.value }],
            };
          }

          case 'list': {
            const { namespace, includeMetadata } = args as { 
              namespace?: string;
              includeMetadata?: boolean;
            };
            
            this.validateNamespace(namespace);

            const keys = await storage.keys();
            const filteredKeys = namespace
              ? keys.filter((k: string) => k.startsWith(`${namespace}:`))
              : keys;

            if (includeMetadata) {
              const items = await Promise.all(
                filteredKeys.map(async (key: string) => {
                  const data = await storage.getItem(key) as StoredValue;
                  return {
                    key,
                    timestamp: data.timestamp,
                    expiry: data.expiry,
                  };
                })
              );
              return {
                content: [{ type: 'text', text: JSON.stringify(items, null, 2) }],
              };
            }

            return {
              content: [{ type: 'text', text: JSON.stringify(filteredKeys, null, 2) }],
            };
          }

          case 'delete': {
            const { key, namespace } = args as { key: string; namespace?: string };
            
            this.validateKey(key);
            this.validateNamespace(namespace);

            const storageKey = namespace ? `${namespace}:${key}` : key;
            await storage.removeItem(storageKey);
            return {
              content: [{ type: 'text', text: `Successfully deleted key: ${key}` }],
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(ErrorCode.InternalError, String(error));
      }
    });
  }

  async run() {
    await this.ensureInitialized();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Memory Bank MCP server running on stdio');
  }
}

const server = new MemoryBankServer();
server.run().catch(console.error);
