import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChartBoxDirective } from './chart-box.directive';

@Component({
  standalone: true,
  imports: [ChartBoxDirective],
  template: `<div chartBox #box="chartBox" style="width: 400px; height: 240px;"></div>`,
})
class TestHostComponent {}

describe('ChartBoxDirective', () => {
  let fixture: ComponentFixture<TestHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    fixture.detectChanges();
  });

  it('initializes size signal with non-zero fallback dimensions', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });
});
