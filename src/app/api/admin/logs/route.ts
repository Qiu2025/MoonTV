/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';

export const runtime = 'edge';

async function checkAdminAuth(request: NextRequest): Promise<boolean> {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) return false;

  const username = authInfo.username;

  // 站长直接通过
  if (username === process.env.USERNAME) return true;

  try {
    const config = await getConfig();
    const user = config.UserConfig.Users.find((u) => u.username === username);
    return !!(user && user.role === 'admin');
  } catch {
    return false;
  }
}

// GET /api/admin/logs — 获取系统日志
export async function GET(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '本地存储模式不支持系统日志' },
      { status: 400 }
    );
  }

  const isAdmin = await checkAdminAuth(request);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 直接写一条测试日志，绕过缓存，验证 D1 写入是否正常
    await db.addSystemLog('info', '[Test] Direct write from logs API', {
      ts: Date.now(),
    });

    const logs = await db.getSystemLogs();
    return NextResponse.json(
      {
        logs,
        _debug: {
          storageType,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hasStorage: !!(db as any).storage,
          logsCount: logs.length,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('获取系统日志失败:', error);
    return NextResponse.json(
      { error: '获取系统日志失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/logs — 清空系统日志
export async function DELETE(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '本地存储模式不支持系统日志' },
      { status: 400 }
    );
  }

  const isAdmin = await checkAdminAuth(request);
  if (!isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await db.clearSystemLogs();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('清空系统日志失败:', error);
    return NextResponse.json(
      { error: '清空系统日志失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
