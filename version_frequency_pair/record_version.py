# 合并版本号 忽略模块
import csv
from collections import defaultdict

# 初始化版本号统计字典
version_summary = defaultdict(int)

# 读取 CSV 文件并统计版本号
input_csv_file = "dependency_counts.csv"  # 替换为你的输入文件路径

def parse_version(version):
    return tuple(map(int, version.split(".")))

with open(input_csv_file, mode="r", newline="", encoding="utf-8") as file:
    reader = csv.reader(file)
    next(reader)  # 跳过表头（第一行）
    for row in reader:
        if len(row) >= 3:  # 确保每行有足够多的列
            version = row[1]  # 版本号在第二列
            count = int(row[2])  # 计数在第三列
            version_summary[version] += count

# 将统计结果输出到新的 CSV 文件
output_csv_file = "version_summary.csv"  # 输出文件路径

with open(output_csv_file, mode="w", newline="", encoding="utf-8") as file:
    writer = csv.writer(file)
    writer.writerow(["version", "count"])  # 写入表头
    for version, count in sorted(version_summary.items(), key=lambda x: parse_version(x[0])):
        writer.writerow([version, count])  # 写入每行数据

print(f"统计结果已保存到文件：{output_csv_file}")