import csv
import matplotlib.pyplot as plt
import pandas as pd

# 画图以及统计频次

# 读取统计结果
input_csv_file = "version_frequency_pair/version_summary.csv"  # 替换为你的统计结果文件路径
versions = []
counts = []

with open(input_csv_file, mode="r", newline="", encoding="utf-8") as file:
    reader = csv.reader(file)
    next(reader)  # 跳过表头
    for row in reader:
        if int(row[0].split(".")[0]) >= 4 and int(row[1]) > 20:
            versions.append(row[0])  # 版本号
            counts.append(int(row[1]))  # 计数

# 绘制柱状图
plt.figure(figsize=(15, 6))  # 设置图表大小
plt.plot(versions, counts, marker='o', linestyle='-', color='blue', markersize=4)
plt.xlabel('version_Id', fontsize=12)
plt.ylabel('Count', fontsize=12)
plt.title('Usage', fontsize=14)
plt.xticks(rotation=90, ha='right')  # 旋转X轴标签，避免重叠
plt.grid(axis='y', linestyle='--', alpha=0.7)  # 添加网格线
plt.tight_layout()
plt.show()



# # 读取统计结果
# input_csv_file = "version_summary.csv"  # 替换为你的统计结果文件路径

# # 读取数据到 DataFrame
# df = pd.read_csv(input_csv_file)

# # 提取主版本号
# df['major_version'] = df['version'].apply(lambda x: x.split('.')[0])

# # 按主版本号分组，并提取每个主版本下使用次数最多的前两个版本
# top_versions = df.groupby('major_version').apply(
#     lambda x: x.nlargest(2, 'count')
# ).reset_index(drop=True)

# # 重新整理数据结构
# result = []
# for major_version, group in top_versions.groupby('major_version'):
#     versions = group[['version', 'count']].values.tolist()
#     if len(versions) >= 2:
#         version_1, count_1 = versions[0]
#         version_2, count_2 = versions[1]
#     elif len(versions) == 1:
#         version_1, count_1 = versions[0]
#         version_2, count_2 = None, None
#     else:
#         version_1, count_1, version_2, count_2 = None, None, None, None
#     result.append([major_version, version_1, count_1, version_2, count_2])

# # 将结果转换为 DataFrame
# result_df = pd.DataFrame(result, columns=['major_version', 'version-1', 'count-1', 'version-2', 'count-2'])

# # 保存到新的 CSV 文件
# output_csv_file = "top_versions.csv"  # 输出文件路径
# result_df.to_csv(output_csv_file, index=False)

# print(f"结果已保存到文件：{output_csv_file}")
# print(result_df)