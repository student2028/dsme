"""
生成红心爱心图案
支持两种模式：
  1. 终端字符画 (简单)
  2. matplotlib 绘制填充红心 (更漂亮)
"""

import math

# ==================== 模式一：终端爱心字符画 ====================

def print_text_heart():
    """在终端打印一个由 ❤ 组成的爱心"""
    words = "I ❤ U"
    words_list = list(words)
    
    for y in range(15, -15, -1):
        row = ""
        for x in range(-30, 30):
            # 心形方程: (x² + y² - 1)³ - x²·y³ ≤ 0
            if ((x * 0.04) ** 2 + (y * 0.1) ** 2 - 1) ** 3 - (x * 0.04) ** 2 * (y * 0.1) ** 3 <= 0:
                # 在中心区域嵌入文字
                if 4 <= len(row) < 8 and words_list:
                    row += words_list.pop(0)
                else:
                    row += "❤"
            else:
                row += "  "
        print(row)


# ==================== 模式二：matplotlib 绘制填充红心 ====================

def plot_heart():
    """用 matplotlib 绘制一个红心图案"""
    import matplotlib.pyplot as plt
    import numpy as np

    # 心形参数方程
    t = np.linspace(0, 2 * np.pi, 1000)
    x = 16 * np.sin(t) ** 3
    y = 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)

    fig, ax = plt.subplots(figsize=(8, 6), facecolor='white')
    
    # 填充红色
    ax.fill(x, y, color='red', alpha=0.95, label='❤')
    
    # 描边（更深红）
    ax.plot(x, y, color='darkred', linewidth=2)
    
    # 美化
    ax.set_aspect('equal')
    ax.set_xlim(-20, 20)
    ax.set_ylim(-20, 18)
    ax.axis('off')  # 隐藏坐标轴
    
    # 添加文字
    ax.text(0, -2, "I ❤ U", fontsize=24, ha='center',
            color='white', fontweight='bold',
            bbox=dict(facecolor='red', edgecolor='white', 
                     boxstyle='round,pad=0.5'))
    
    plt.title("❤ 爱心 ❤", fontsize=18, color='red')
    plt.tight_layout()
    plt.show()


# ==================== 模式三：使用 turtle 绘制红心动画 ====================

def draw_heart_turtle():
    """用 turtle 模块绘制红心（动画效果）"""
    import turtle

    t = turtle.Turtle()
    t.speed(5)
    t.pensize(2)
    
    # 移动到起始位置
    t.penup()
    t.goto(0, -100)
    t.pendown()
    t.color('red', 'red')
    t.begin_fill()
    
    # 左半心
    t.left(140)
    t.forward(180)
    t.circle(-90, 200)
    
    # 右半心
    t.left(120)
    t.circle(-90, 200)
    t.forward(180)
    
    t.end_fill()
    
    # 添加文字
    t.penup()
    t.goto(0, 50)
    t.color('white')
    t.write("I ❤ U", align='center', font=('Arial', 28, 'bold'))
    
    t.hideturtle()
    turtle.done()


if __name__ == '__main__':
    print("=" * 40)
    print("选择模式：")
    print("1 - 终端字符画 ❤")
    print("2 - matplotlib 红心图")
    print("3 - turtle 红心动图")
    print("=" * 40)
    
    try:
        mode = int(input("请输入数字 (1/2/3): "))
    except (ValueError, EOFError):
        mode = 1
    
    if mode == 1:
        print("\n" + "❤" * 20 + " 终端爱心 " + "❤" * 20 + "\n")
        print_text_heart()
    elif mode == 2:
        plot_heart()
    elif mode == 3:
        draw_heart_turtle()
    else:
        print("无效输入，默认运行终端字符画。")
        print_text_heart()
