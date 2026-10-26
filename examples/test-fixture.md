# mdview 测试文档

这是一个用来验证渲染效果的文档，包含**粗体**、*斜体*、~~删除线~~、`行内代码`、==高亮== 和 [外部链接](https://example.com)。

## 二级标题

> 引用块
> 第二行
>
> > 嵌套引用

### 列表

- 无序项一
- 无序项二
  - 嵌套项 A
  - 嵌套项 B
    1. 有序子项
    2. 另外一个
- [x] 已完成的任务
- [ ] 未完成的任务

1. 第一
2. 第二
3. 第三

#### 代码

```js
// JavaScript 高亮测试
function greet(name) {
  const msg = "你好, " + name;
  return msg + '!';
}
greet('world');
```

```python
# Python
def fib(n):
    a, b = 0, 1
    while a < n:
        print(a)
        a, b = b, a + b
```

```sql
SELECT id, name FROM users WHERE age > 18 ORDER BY name LIMIT 10;
```

```
无语言标记的代码块
  indent 保留
```

##### 表格

| 功能 | 状态 | 备注 |
|:-----|:----:|-----:|
| 渲染 | ✅ | 支持 GFM 表格 |
| 高亮 | ✅ | 内置离线高亮 |
| 目录 | ✅ | 点击右上「大纲」 |

###### 其它

行内 HTML 会按字面显示：<span class="x">不会被解析</span>

分隔线：

---

图片测试（同一目录下）：

![不存在的图片](missing.png)

本地链接：[跳到另一个文件](sub/other.md)

锚点链接：[回到顶部](#mdview-测试文档)

URL 自动链接：https://nodejs.org/dist/
