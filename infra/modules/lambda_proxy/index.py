import json
import urllib3
import os
import socket

http = urllib3.PoolManager()

def lambda_handler(event, context):
    print("Event:", json.dumps(event))
    
    path = event.get('rawPath', '')
    query_string = event.get('rawQueryString', '')
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET')
    headers = event.get('headers', {})
    body = event.get('body', '')
    is_base64_encoded = event.get('isBase64Encoded', False)

    # Determine backend service based on path
    # Routes: /read-service/* and /write-service/*
    if path.startswith('/read-service/'):
        target_host = "read.helpme.local"
        target_port = 8080 # Default port for our Go services
        stripped_path = path.replace('/read-service', '', 1)
    elif path.startswith('/write-service/'):
        target_host = "write.helpme.local"
        target_port = 8080
        stripped_path = path.replace('/write-service', '', 1)
    else:
        return {
            'statusCode': 404,
            'body': json.dumps({'error': 'Service not found at ' + path})
        }

    # Construct target URL
    if not stripped_path:
        stripped_path = "/"
    
    url = f"http://{target_host}:{target_port}{stripped_path}"
    if query_string:
        url += f"?{query_string}"

    print(f"Proxying {method} {path} to {url}")

    # Prepare headers for backend (passing through auth headers)
    # Important: Remove 'Host' header to let urllib3 handle it correctly
    forward_headers = {k: v for k, v in headers.items() if k.lower() != 'host'}

    # Inject Auth headers from API Gateway Authorizer context
    authorizer = event.get('requestContext', {}).get('authorizer', {}).get('lambda', {})
    if not authorizer:
        # Fallback for some configurations where it might be directly under 'authorizer'
        authorizer = event.get('requestContext', {}).get('authorizer', {})
        
    if authorizer.get('userId'):
        forward_headers['X-Cognito-Id'] = str(authorizer['userId'])
    if authorizer.get('role'):
        forward_headers['X-Role'] = str(authorizer['role'])

    try:
        # Perform the request
        response = http.request(
            method,
            url,
            headers=forward_headers,
            body=body,
            decode_content=False,
            retries=False,
            timeout=10.0
        )

        return {
            'statusCode': response.status,
            'headers': dict(response.headers),
            'body': response.data.decode('utf-8') if response.data else "",
            'isBase64Encoded': False
        }
    except Exception as e:
        print(f"Proxy Error: {str(e)}")
        return {
            'statusCode': 502,
            'body': json.dumps({'error': 'Proxy Error', 'details': str(e)})
        }
