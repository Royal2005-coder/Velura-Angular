import { blogEditorText, blogRowHtml, htmlFromPlainText, legacyBlogContentHtml, pasteHtmlFromClipboard, sanitizeEditorHtml } from './admin-erp-blog-html';

describe('admin blog HTML boundary', () => {
  it('keeps article structure but removes scripts, event handlers and unsafe URLs', () => {
    const clean = sanitizeEditorHtml(
      '<h2 style="color:red">Xu hướng</h2><p onclick="steal()">Mùa <strong>hè</strong></p>' +
      '<script>alert(1)</script><iframe src="https://evil.test"></iframe>' +
      '<img src="javascript:alert(1)" onerror="steal()"><img src="https://cdn.velura.vn/a.jpg" width="600" onload="x()">' +
      '<a href="javascript:alert(1)">bad</a><a href="https://velura.vn/shop" target="_blank">shop</a>',
    );
    expect(clean).toContain('<h2>Xu hướng</h2>');
    expect(clean).toContain('<strong>hè</strong>');
    expect(clean).toContain('<img src="https://cdn.velura.vn/a.jpg" width="600" loading="lazy" alt="">');
    expect(clean).toContain('rel="noopener noreferrer"');
    expect(clean).not.toMatch(/script|iframe|onclick|onerror|onload|javascript:|style=/i);
  });

  it('preserves full editorial semantic HTML with figures and safe inline styles', () => {
    const sample =
      '<article>' +
      '<h1>Quiet Luxury: Nghệ thuật mặc đẹp từ sự tối giản</h1>' +
      '<p><em>Không cần quá nhiều chi tiết để trở nên nổi bật.</em></p>' +
      '<figure>' +
      '<img src="https://images.pexels.com/photos/9142805/pexels-photo-9142805.jpeg" alt="Quiet Luxury" width="100%" style="display:block;width:100%;height:auto;max-height:650px;object-fit:cover;border-radius:12px;">' +
      '<figcaption>Quiet Luxury – vẻ đẹp của sự tối giản và tinh tế.</figcaption>' +
      '</figure>' +
      '<h2>1. Quiet Luxury là gì?</h2>' +
      '</article>';
    const clean = sanitizeEditorHtml(sample);
    expect(clean).toContain('<article>');
    expect(clean).toContain('<h1>Quiet Luxury: Nghệ thuật mặc đẹp từ sự tối giản</h1>');
    expect(clean).toContain('<em>Không cần quá nhiều chi tiết để trở nên nổi bật.</em>');
    expect(clean).toContain('<figure>');
    expect(clean).toContain('width="100%"');
    expect(clean).toContain('style="display:block;width:100%;height:auto;max-height:650px;object-fit:cover;border-radius:12px"');
    expect(clean).toContain('<figcaption>Quiet Luxury – vẻ đẹp của sự tối giản và tinh tế.</figcaption>');
    expect(clean).toContain('<h2>1. Quiet Luxury là gì?</h2>');
    expect(blogEditorText(clean)).toContain('Quiet Luxury: Nghệ thuật mặc đẹp từ sự tối giản');
    expect(blogEditorText(clean)).toContain('1. Quiet Luxury là gì?');
  });

  it('keeps block boundaries apart for the minimum-length rule', () => {
    expect(blogEditorText('<h2>Xu hướng</h2><p>Mùa hè</p>')).toBe('Xu hướng Mùa hè');
    expect(blogEditorText('<script>alert(1)</script>')).toBe('');
  });

  it('converts legacy plain text without letting it become markup', () => {
    expect(htmlFromPlainText('Dòng 1 <b>x</b>\n\nDòng 2')).toBe('<p>Dòng 1 &lt;b&gt;x&lt;/b&gt;</p><p>Dòng 2</p>');
    expect(blogRowHtml({ content: 'Đoạn cũ đủ dài', content_html: '' })).toBe('<p>Đoạn cũ đủ dài</p>');
    expect(blogRowHtml({ content: 'cũ', content_html: '<p>mới</p>' })).toBe('<p>mới</p>');
  });

  it('converts legacy JSON editorial content into editable sections', () => {
    const legacy = JSON.stringify({
      intro: 'Mở bài',
      takeaways: ['Ý một', 'Ý hai'],
      sections: [{ heading: 'Chất liệu', body: ['Đoạn một', 'Đoạn hai'] }],
    });
    const html = legacyBlogContentHtml(legacy);
    expect(html).toContain('<p>Mở bài</p>');
    expect(html).toContain('<h2>Điểm chính</h2>');
    expect(html).toContain('<li>Ý một</li>');
    expect(html).toContain('<h2>Chất liệu</h2>');
    expect(html).toContain('<p>Đoạn hai</p>');
    expect(blogRowHtml({ content_html: '', content: legacy })).toBe(html);
    expect(legacyBlogContentHtml('plain text')).toBe('');
  });

  it('falls back to escaped clipboard text when the browser sends no HTML', () => {
    expect(pasteHtmlFromClipboard('', 'Dòng 1\nDòng 2')).toBe('<p>Dòng 1<br>Dòng 2</p>');
    expect(pasteHtmlFromClipboard('<p>ok</p>', 'ignored')).toBe('<p>ok</p>');
  });
});
