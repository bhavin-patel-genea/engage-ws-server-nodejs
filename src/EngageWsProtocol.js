'use strict';

/**
 * EngageRequest
 *
 * An HTTP-style request sent from the server to a gateway over the WebSocket channel.
 * The server (Genea Cloud) acts as the HTTP client; the gateway acts as the HTTP server.
 */
class EngageRequest {
  /**
   * @param {number} requestId
   * @param {string} requestMethod            e.g. "GET", "PUT"
   * @param {string} requestPath              e.g. "/edgeDevices/linkList"
   * @param {string} requestMessageBody       JSON string or empty string
   * @param {string} [requestOptionalStrings] Query string parameters
   */
  constructor(requestId, requestMethod, requestPath, requestMessageBody, requestOptionalStrings = '') {
    this.requestId = requestId;
    this.requestMethod = requestMethod;
    this.requestPath = requestPath;
    this.requestMessageBody = requestMessageBody;
    this.requestOptionalStrings = requestOptionalStrings;
  }

  createPayload() {
    const payload = {
      requestId: this.requestId,
      request: {
        method: this.requestMethod,
        path: this.requestPath,
        messageBody: this.requestMessageBody,
      },
    };
    if (this.requestOptionalStrings) {
      payload.request.optionalQueryStrings = this.requestOptionalStrings;
    }
    return JSON.stringify(payload);
  }

  logString() {
    return `[req ${this.requestId}] ${this.requestMethod} ${this.requestPath}`;
  }

  debugPrint() {
    console.log(`[EngageRequest ${this.requestId}] ${this.requestMethod} ${this.requestPath}`);
    if (this.requestMessageBody) console.log(`  body: ${this.requestMessageBody}`);
    if (this.requestOptionalStrings) console.log(`  query: ${this.requestOptionalStrings}`);
  }
}


/**
 * EngageResponse
 *
 * A response received from a gateway, correlated to an EngageRequest by requestId.
 */
class EngageResponse {
  /**
   * @param {number} requestId
   * @param {string} responseStatus       HTTP-style status code, e.g. "200"
   * @param {string} responseMessageBody
   */
  constructor(requestId, responseStatus, responseMessageBody) {
    this.requestId = requestId;
    this.responseStatus = responseStatus;
    this.responseMessageBody = responseMessageBody;
  }

  logString() {
    return `[res ${this.requestId}] status=${this.responseStatus}`;
  }

  debugPrint() {
    console.log(`[EngageResponse ${this.requestId}] status=${this.responseStatus}`);
    if (this.responseMessageBody) console.log(`  body: ${this.responseMessageBody}`);
  }
}


/**
 * EngageEventSubscription
 *
 * Sent from the server to a gateway immediately after connection to configure
 * which event sources the gateway should stream back.
 *
 * Must be re-sent after every reconnection — the gateway does not persist subscriptions.
 */
class EngageEventSubscription {
  /**
   * @param {number}  subscriptionId
   * @param {boolean} subGatewayEnabled
   * @param {boolean} subEdgeDeviceEnabled
   */
  constructor(subscriptionId, subGatewayEnabled, subEdgeDeviceEnabled) {
    this.subscriptionId = subscriptionId;
    this.subGatewayEnabled = subGatewayEnabled;
    this.subEdgeDeviceEnabled = subEdgeDeviceEnabled;
    this.subGatewaySource = 'gateway';
    this.subEdgeDeviceSource = 'edgeDevice';
    this.subGatewayBody = {};
    this.subEdgeDeviceBody = {};
  }

  createPayload() {
    return JSON.stringify({
      subscriptionId: this.subscriptionId,
      subscription: [
        {
          source: this.subGatewaySource,
          eventingEnabled: this.subGatewayEnabled,
          subscriptionBody: this.subGatewayBody,
        },
        {
          source: this.subEdgeDeviceSource,
          eventingEnabled: this.subEdgeDeviceEnabled,
          subscriptionBody: this.subEdgeDeviceBody,
        },
      ],
    });
  }

  logString() {
    return `[sub ${this.subscriptionId}] gateway=${this.subGatewayEnabled} edgeDevice=${this.subEdgeDeviceEnabled}`;
  }

  debugPrint() {
    console.log(`[EngageEventSubscription ${this.subscriptionId}]`);
    console.log(`  gateway=${this.subGatewayEnabled}  edgeDevice=${this.subEdgeDeviceEnabled}`);
  }
}


/**
 * EngageEvent
 *
 * An asynchronous event pushed from a gateway (e.g. badge read, door open, lock state change).
 * Events are not correlated to any request — they arrive independently on the WebSocket.
 */
class EngageEvent {
  /**
   * @param {number} eventId
   * @param {string} eventType
   * @param {string} eventSource    "gateway" | "edgeDevice"
   * @param {string} eventDeviceId
   * @param {string} eventBody
   */
  constructor(eventId, eventType, eventSource, eventDeviceId, eventBody) {
    this.eventId = eventId;
    this.eventType = eventType;
    this.eventSource = eventSource;
    this.eventDeviceId = eventDeviceId;
    this.eventBody = eventBody;
  }

  logString() {
    return `[event ${this.eventId}] type=${this.eventType} source=${this.eventSource} device=${this.eventDeviceId}`;
  }

  debugPrint() {
    console.log(`[EngageEvent ${this.eventId}] type=${this.eventType} source=${this.eventSource} device=${this.eventDeviceId}`);
    if (this.eventBody) console.log(`  body: ${JSON.stringify(this.eventBody)}`);
  }
}


module.exports = { EngageRequest, EngageResponse, EngageEventSubscription, EngageEvent };
