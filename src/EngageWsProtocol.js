'use strict';

/**
 * EngageRequest - Represents an HTTP-style request sent from the server to a gateway.
 */
class EngageRequest {
  /**
   * @param {number} requestId
   * @param {string} requestMethod    e.g. "GET", "POST"
   * @param {string} requestPath      e.g. "/gateway/scanList"
   * @param {string} requestMessageBody
   * @param {string} [requestOptionalStrings]
   */
  constructor(requestId, requestMethod, requestPath, requestMessageBody, requestOptionalStrings = '') {
    this.requestId = requestId;
    this.requestMethod = requestMethod;
    this.requestPath = requestPath;
    this.requestMessageBody = requestMessageBody;
    this.requestOptionalStrings = requestOptionalStrings;
  }

  debugPrint() {
    console.log('@@@@@@@@@Request@@@@@@@@');
    console.log('requestId:', this.requestId);
    console.log('Request Method:', this.requestMethod);
    console.log('Request Path:', this.requestPath);
    console.log('Request Body:', this.requestMessageBody);
    if (this.requestOptionalStrings) {
      console.log('Request Optional Strings:', this.requestOptionalStrings);
    }
    console.log('@@@@@@@@@@@@@@@@@@@@@@@@');
  }

  /** Serialize to a JSON string (UTF-8 Buffer) suitable for sending over WebSocket. */
  createPayload() {
    const request = {
      requestId: this.requestId,
      request: {
        method: this.requestMethod,
        path: this.requestPath,
        messageBody: this.requestMessageBody,
      },
    };
    if (this.requestOptionalStrings) {
      request.request.optionalQueryStrings = this.requestOptionalStrings;
    }
    return JSON.stringify(request);
  }

  logString() {
    return `${this.requestId}, ${this.requestMethod}, ${this.requestPath}, ${this.requestMessageBody}, ${this.requestOptionalStrings}`;
  }
}


/**
 * EngageResponse - Represents a response received from a gateway.
 */
class EngageResponse {
  /**
   * @param {number} requestId
   * @param {string} responseStatus   HTTP-style status code as string, e.g. "200"
   * @param {string} responseMessageBody
   */
  constructor(requestId, responseStatus, responseMessageBody) {
    this.requestId = requestId;
    this.responseStatus = responseStatus;
    this.responseMessageBody = responseMessageBody;
  }

  debugPrint() {
    console.log('========Response========');
    console.log('requestId:', this.requestId);
    console.log('Response Status:', this.responseStatus);
    console.log('Response Body:', this.responseMessageBody);
    console.log('========================');
  }

  logString() {
    return `${this.requestId}, ${this.responseStatus}, ${this.responseMessageBody}`;
  }
}


/**
 * EngageEventSubscription - Sent from server to gateway to configure event subscriptions.
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

  debugPrint() {
    console.log('%%%Event Subscription%%%');
    console.log('sub_id:', this.subscriptionId);
    console.log('sub gateway source:', this.subGatewaySource);
    console.log('sub gateway enabled:', this.subGatewayEnabled);
    console.log('sub gateway body:', this.subGatewayBody);
    console.log('sub edgedevice source:', this.subEdgeDeviceSource);
    console.log('sub edgedevice enabled:', this.subEdgeDeviceEnabled);
    console.log('sub edgedevice body:', this.subEdgeDeviceBody);
    console.log('%%%%%%%%%%%%%%%%%%%%%%%%');
  }

  /** Serialize to a JSON string suitable for sending over WebSocket. */
  createPayload() {
    const sub = {
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
    };
    return JSON.stringify(sub);
  }

  logString() {
    return `${this.subscriptionId}, ${this.subGatewayEnabled}, ${this.subEdgeDeviceEnabled}`;
  }
}


/**
 * EngageEvent - Represents an asynchronous event received from a gateway.
 */
class EngageEvent {
  /**
   * @param {number} eventId
   * @param {string} eventType
   * @param {string} eventSource
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

  debugPrint() {
    console.log('*********Event**********');
    console.log('eventId:', this.eventId);
    console.log('Event Type:', this.eventType);
    console.log('Event Source:', this.eventSource);
    console.log('Event deviceId:', this.eventDeviceId);
    console.log('Event Body:', this.eventBody);
    console.log('************************');
  }

  logString() {
    return `${this.eventId}, ${this.eventType}, ${this.eventSource}, ${this.eventDeviceId}, ${this.eventBody}`;
  }
}


module.exports = { EngageRequest, EngageResponse, EngageEventSubscription, EngageEvent };
