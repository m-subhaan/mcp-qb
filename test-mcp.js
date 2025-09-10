#!/usr/bin/env node

import fetch from 'node-fetch';

const MCP_SERVER_URL = 'https://mcp-qb.vercel.app';

// Test 1: Basic health check
async function testHealthCheck() {
  console.log('🔍 Testing basic health check...');
  try {
    const response = await fetch(`${MCP_SERVER_URL}/`);
    const data = await response.json();
    console.log('✅ Health check response:', JSON.stringify(data, null, 2));
    return data.authenticated;
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    return false;
  }
}

// Test 2: Test SSE endpoint connectivity
async function testSSEEndpoint() {
  console.log('🔍 Testing SSE endpoint connectivity...');
  try {
    const response = await fetch(`${MCP_SERVER_URL}/sse`, {
      method: 'GET',
      headers: {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      }
    });
    
    console.log('📊 SSE Response Status:', response.status);
    console.log('📊 SSE Response Headers:', Object.fromEntries(response.headers.entries()));
    
    if (response.status === 200) {
      console.log('✅ SSE endpoint is accessible');
      return true;
    } else {
      console.error('❌ SSE endpoint returned status:', response.status);
      const text = await response.text();
      console.error('Response body:', text);
      return false;
    }
  } catch (error) {
    console.error('❌ SSE endpoint test failed:', error.message);
    return false;
  }
}

// Test 3: Test MCP protocol handshake (updated to use /messages endpoint)
async function testMCPHandshake() {
  console.log('🔍 Testing MCP protocol handshake...');
  try {
    const response = await fetch(`${MCP_SERVER_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {
            roots: {
              listChanged: true
            },
            sampling: {}
          },
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      })
    });

    console.log('📊 MCP Handshake Status:', response.status);
    if (response.status === 200 || response.status === 202) {
      console.log('✅ MCP handshake successful');
      const text = await response.text();
      console.log('Response:', text);
      return true;
    } else {
      console.error('❌ MCP handshake failed');
      const text = await response.text();
      console.error('Response:', text);
      return false;
    }
  } catch (error) {
    console.error('❌ MCP handshake error:', error.message);
    return false;
  }
}

// Test 4: Check authentication status
async function testAuthentication() {
  console.log('🔍 Testing QuickBooks authentication...');
  try {
    const response = await fetch(`${MCP_SERVER_URL}/`);
    const data = await response.json();
    
    if (data.authenticated) {
      console.log('✅ QuickBooks authentication is active');
      return true;
    } else {
      console.log('⚠️  QuickBooks not authenticated');
      console.log(`🔗 To authenticate, visit: ${MCP_SERVER_URL}/auth`);
      return false;
    }
  } catch (error) {
    console.error('❌ Authentication check failed:', error.message);
    return false;
  }
}

// Test 5: Test with curl-like request
function generateCurlCommand() {
  console.log('🔍 Here are curl commands you can run to test manually:');
  console.log('\n1. Health check:');
  console.log(`curl -X GET "${MCP_SERVER_URL}/"`);
  
  console.log('\n2. SSE endpoint:');
  console.log(`curl -X GET "${MCP_SERVER_URL}/sse" -H "Accept: text/event-stream"`);
  
  console.log('\n3. MCP Initialize (corrected endpoint):');
  console.log(`curl -X POST "${MCP_SERVER_URL}/messages" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {
        "roots": {"listChanged": true},
        "sampling": {}
      },
      "clientInfo": {"name": "test-client", "version": "1.0.0"}
    }
  }'`);
}

// Test 6: Test tools listing
async function testToolsListing() {
  console.log('🔍 Testing tools listing...');
  try {
    const response = await fetch(`${MCP_SERVER_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      })
    });

    console.log('📊 Tools List Status:', response.status);
    if (response.status === 200 || response.status === 202) {
      const text = await response.text();
      console.log('✅ Tools list response:', text);
      return true;
    } else {
      console.error('❌ Tools listing failed');
      const text = await response.text();
      console.error('Response:', text);
      return false;
    }
  } catch (error) {
    console.error('❌ Tools listing error:', error.message);
    return false;
  }
}

// Main test runner
async function runAllTests() {
  console.log('🚀 Starting MCP Server Tests...\n');
  
  const results = {
    healthCheck: await testHealthCheck(),
    sseEndpoint: await testSSEEndpoint(),
    mcpHandshake: await testMCPHandshake(),
    toolsListing: await testToolsListing(),
    authentication: await testAuthentication()
  };
  
  console.log('\n📋 Test Results Summary:');
  console.log('========================');
  Object.entries(results).forEach(([test, passed]) => {
    console.log(`${passed ? '✅' : '❌'} ${test}: ${passed ? 'PASSED' : 'FAILED'}`);
  });
  
  const allPassed = Object.values(results).every(Boolean);
  console.log(`\n${allPassed ? '🎉' : '⚠️'} Overall: ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
  
  if (!results.authentication) {
    console.log(`\n🔐 Authentication Required:`);
    console.log(`Visit ${MCP_SERVER_URL}/auth to authenticate with QuickBooks`);
  }
  
  console.log('\n🛠️  Manual Testing Commands:');
  generateCurlCommand();
  
  return allPassed;
}

// Run tests
runAllTests().catch(console.error); 