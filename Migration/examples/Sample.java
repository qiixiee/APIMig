package demo;

public class Sample {
  private final int seed = 1;

  public int add(int left, int right) {
    int base = seed;
    int total = left + right + base;
    log(total);
    return total;
  }

  private void log(int value) {
    System.out.println(value);
  }
}
