/**
 * About Dialog Component - Shows app information
 */

import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

import { APP_NAME, APP_VERSION } from '../../../../shared/constants';

@Component({
  selector: 'app-about-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule
  ],
  templateUrl: './about-dialog.component.html',
  styleUrl: './about-dialog.component.scss'
})
export class AboutDialogComponent {
  appName = APP_NAME;
  appVersion = APP_VERSION;

  constructor(private dialogRef: MatDialogRef<AboutDialogComponent>) {}

  close(): void {
    this.dialogRef.close();
  }
}
