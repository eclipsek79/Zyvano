/** In-app notifications. */
import type { NotificationRepository } from '../repositories/notification-repository';

export class NotificationService {
  constructor(private readonly repository: NotificationRepository) {}

  async notify(input: {
    userId: string;
    organizationId?: string | null;
    type: string;
    title: string;
    body?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
  }): Promise<void> {
    await this.repository.create(input);
  }

  async list(userId: string, limit = 50) {
    return this.repository.listForUser(userId, limit);
  }

  async unreadCount(userId: string): Promise<number> {
    return this.repository.countUnread(userId);
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.repository.markRead(userId, id);
  }

  async markAllRead(userId: string): Promise<number> {
    return this.repository.markAllRead(userId);
  }
}
