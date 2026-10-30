import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiService } from './api.service';
import { BlogCatalogService } from './blog-catalog.service';

describe('BlogCatalogService', () => {
  it('turns legacy JSON editorial content into renderable article HTML', () => {
    TestBed.configureTestingModule({
      providers: [{
        provide: ApiService,
        useValue: {
          get: () => of({ rows: [{
            slug: 'bang-mau-mua-thu',
            title: 'Bảng màu mùa thu',
            content: JSON.stringify({
              intro: 'Mở bài mùa thu.',
              takeaways: ['Ý một'],
              sections: [{ heading: 'Chất liệu', body: ['Đoạn một'] }],
            }),
          }] }),
        },
      }],
    });
    const catalog = TestBed.inject(BlogCatalogService);
    const post = catalog.list()[0];
    expect(post.contentHtml).toContain('<p>Mở bài mùa thu.</p>');
    expect(post.contentHtml).toContain('<h2>Điểm chính</h2>');
    expect(post.contentHtml).toContain('<h2>Chất liệu</h2>');
  });
});
