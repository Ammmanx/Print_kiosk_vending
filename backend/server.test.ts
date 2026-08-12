import request from 'supertest';
import * as crypto from 'crypto';
import { app, checkoutSchema, isValidMagicBytes } from './server';

describe('InstaPrint Backend Tests', () => {
  beforeEach(async () => {
    process.env.RAZORPAY_KEY_SECRET = 'test_secret';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook_secret';

    const shops = ['test_shop', 'test_shop_sig', 'test_shop_sig_valid', 'test_shop_token_counter'];
    for (const shopId of shops) {
      await request(app)
        .post(`/api/v1/settings/${shopId}`)
        .send({
          bwPrice: 2,
          colorPrice: 10,
          maxPagesPerBatch: 80,
          cooldownMin: 5
        });
    }
  });

  describe('Zod Schema & Magic Bytes Validation', () => {
    it('should validate valid checkout data', () => {
      const validData = {
        fileUrl: 'https://example.com/file.pdf',
        printType: 'bw',
        totalPages: 5,
        copies: 1,
        clientId: 'client_123',
        customerContact: 'test@example.com',
        shopId: 'test_shop',
        paperSize: 'A4'
      };
      const result = checkoutSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should reject invalid checkout data', () => {
      const invalidData = {
        fileUrl: 'not-a-url',
        printType: 'invalid-type',
        totalPages: -1,
        copies: 0
      };
      const result = checkoutSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('should validate PDF magic bytes correctly', () => {
      const mockPdf = Buffer.from('%PDF-1.4 mock data');
      expect(isValidMagicBytes(mockPdf)).toBe(true);

      const mockPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      expect(isValidMagicBytes(mockPng)).toBe(true);

      const mockJpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
      expect(isValidMagicBytes(mockJpg)).toBe(true);

      const invalidBytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      expect(isValidMagicBytes(invalidBytes)).toBe(false);
    });
  });

  describe('Razorpay Signature Verification', () => {
    it('should return error on invalid signature', async () => {
      const response = await request(app)
        .post('/api/checkout')
        .send({
          fileUrl: 'https://example.com/file.pdf',
          printType: 'bw',
          totalPages: 1,
          copies: 1,
          clientId: 'client_123',
          shopId: 'test_shop_sig',
          status: 'pending',
          payment: {
            orderId: 'order_123',
            paymentId: 'pay_123',
            signature: 'invalid_signature',
            method: 'upi'
          }
        });
      
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('verification failed');
    });

    it('should proceed on valid signature', async () => {
      const keySecret = 'test_secret';
      const orderId = 'order_123';
      const paymentId = 'pay_123';
      const hmac = crypto.createHmac('sha256', keySecret);
      hmac.update(orderId + '|' + paymentId);
      const validSignature = hmac.digest('hex');

      const response = await request(app)
        .post('/api/checkout')
        .send({
          fileUrl: 'https://example.com/file.pdf',
          printType: 'bw',
          totalPages: 1,
          copies: 1,
          clientId: 'client_sig_valid',
          shopId: 'test_shop_sig_valid',
          status: 'pending',
          payment: {
            orderId,
            paymentId,
            signature: validSignature,
            method: 'upi'
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Webhook HMAC Verification', () => {
    it('should reject webhook with invalid signature', async () => {
      const response = await request(app)
        .post('/api/webhook/razorpay')
        .set('x-razorpay-signature', 'invalid_sig')
        .send({ event: 'payment.captured' });

      expect(response.status).toBe(400);
    });

    it('should accept webhook with valid signature', async () => {
      const bodyObj = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_capture_123',
              notes: { jobId: 'mock_job_123' }
            }
          }
        }
      };
      const bodyPayload = JSON.stringify(bodyObj);
      const hmac = crypto.createHmac('sha256', 'webhook_secret');
      hmac.update(Buffer.from(bodyPayload));
      const validWebhookSignature = hmac.digest('hex');

      const response = await request(app)
        .post('/api/webhook/razorpay')
        .set('x-razorpay-signature', validWebhookSignature)
        .set('content-type', 'application/json')
        .send(bodyPayload);

      expect(response.status).toBe(200);
    });
  });

  describe('Daily Token Number Counter Logic', () => {
    it('should generate incrementing token numbers', async () => {
      const todayDayStr = String(new Date().getDate()).padStart(2, '0');

      const response1 = await request(app)
        .post('/api/checkout')
        .send({
          fileUrl: 'https://example.com/file.pdf',
          printType: 'bw',
          totalPages: 1,
          copies: 1,
          clientId: 'client_token_test_1',
          shopId: 'test_shop_token_counter',
          status: 'pending_payment'
        });

      expect(response1.status).toBe(200);
      expect(response1.body.tokenNumber).toBe(`${todayDayStr}-1`);

      const response2 = await request(app)
        .post('/api/checkout')
        .send({
          fileUrl: 'https://example.com/file.pdf',
          printType: 'bw',
          totalPages: 1,
          copies: 1,
          clientId: 'client_token_test_2',
          shopId: 'test_shop_token_counter',
          status: 'pending_payment'
        });

      expect(response2.status).toBe(200);
      expect(response2.body.tokenNumber).toBe(`${todayDayStr}-2`);
    });
  });
});
